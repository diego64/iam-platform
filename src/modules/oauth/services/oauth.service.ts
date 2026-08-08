/**
 * Responsabilidade: orquestrar a emissão de token pelos grants da RFC 6749.
 * Consumido por: o controller da rota `POST /oauth/token`.
 * Regras:
 *  - Nada de autenticação nova aqui: o par do cliente é verificado pelo módulo de clientes, a
 *    senha do usuário pelo de autenticação e a rotação pelo de refresh. Este serviço é a
 *    tradução do protocolo mais o rebaixamento de autoridade.
 *  - Toda falha de autenticação de cliente vira o mesmo `invalid_client`: o serviço de
 *    clientes já devolve `null` único para inexistente, removido, desabilitado e segredo
 *    errado, e diferenciar aqui desfaria essa decisão.
 *  - O grant precisa constar em `grant_types` do cliente. É a trava por cliente que permite
 *    liberar `password` para uma aplicação de confiança sem liberá-lo para todas.
 *  - Nenhum Fastify nem driver: tudo entra por injeção.
 */
import { ErroDeOAuth } from '../errors/oauth-error.js';
import { calcularEscopoConcedido, formatarEscopo } from './scope-grant.js';
import type { CredencialDeCliente } from './client-credentials.js';
import type { ClientAuthService } from '../../api-clients/services/client-auth.service.js';
import type { ClienteAutenticado, TipoDeGrant } from '../../api-clients/types/api-client.types.js';
import type { TokenService } from '../../auth/services/token.service.js';
import type { AuthService } from '../../auth/services/auth.service.js';
import type { RefreshTokenService } from '../../refresh-token/services/refresh-token.service.js';
import { ErroDeRefreshInvalido } from '../../refresh-token/errors/refresh-token-error.js';
import { medidorDeOAuthNulo, type MedidorDeOAuth } from '../metrics/oauth.metrics.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';

const GRANTS_CONHECIDOS: readonly TipoDeGrant[] = [
  'client_credentials',
  'password',
  'refresh_token',
];

export interface PedidoDeToken {
  readonly grantType: string;
  readonly credencial: CredencialDeCliente;
  readonly escoposSolicitados?: readonly string[] | undefined;
  /** `password` grant: credencial do dono do recurso. */
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** `refresh_token` grant: o token opaco a ser rotacionado. */
  readonly refreshToken?: string | undefined;
}

/** A resposta da RFC 6749 §5.1, no vocabulário do domínio. */
export interface TokenConcedido {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly scope: string;
  readonly refreshToken?: string;
}

export interface DependenciasDoOAuthService {
  readonly clientAuth: ClientAuthService;
  readonly tokenService: TokenService;
  readonly authService: Pick<AuthService, 'login'>;
  readonly refreshTokenService: Pick<RefreshTokenService, 'rotacionar'>;
  readonly medidor?: MedidorDeOAuth;
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
  /**
   * Interruptor global do `password` grant. Desligado, o grant deixa de existir para todos
   * os clientes — a saída de incidente que não depende de editar cliente por cliente.
   */
  readonly passwordGrantHabilitado: boolean;
}

export interface OAuthService {
  emitir(pedido: PedidoDeToken): Promise<TokenConcedido>;
}

function ehGrantConhecido(valor: string): valor is TipoDeGrant {
  return (GRANTS_CONHECIDOS as readonly string[]).includes(valor);
}

export function criarOAuthService(deps: DependenciasDoOAuthService): OAuthService {
  const medidor = deps.medidor ?? medidorDeOAuthNulo();
  const auditoria = deps.auditoria ?? registradorNulo();

  /** Autentica o cliente e confirma que ele pode usar o grant pedido. */
  async function autorizarCliente(pedido: PedidoDeToken): Promise<ClienteAutenticado> {
    const cliente = await deps.clientAuth.autenticar(
      pedido.credencial.clientId,
      pedido.credencial.secret,
    );
    if (cliente === null) {
      throw new ErroDeOAuth('invalid_client');
    }

    if (!ehGrantConhecido(pedido.grantType)) {
      throw new ErroDeOAuth('unsupported_grant_type');
    }

    if (!cliente.grantTypes.includes(pedido.grantType)) {
      throw new ErroDeOAuth('unauthorized_client');
    }

    return cliente;
  }

  /**
   * `client_credentials`: o cliente fala por si mesmo, então ele é o próprio sujeito e a
   * interseção degenera para o que ele tem.
   */
  async function porCredenciaisDoCliente(
    cliente: ClienteAutenticado,
    escoposSolicitados: readonly string[] | undefined,
  ): Promise<TokenConcedido> {
    const concedido = calcularEscopoConcedido({
      solicitados: escoposSolicitados,
      escoposDoCliente: cliente.escopos,
      autoridadeDoSujeito: cliente.escopos,
    });
    const escopo = formatarEscopo(concedido);

    const emitido = await deps.tokenService.emitir(
      {
        sub: cliente.clientId,
        roles: [],
        permissions: [...concedido],
        scope: escopo,
        subType: 'client',
        clientId: cliente.clientId,
      },
      cliente.accessTokenTtlSegundos === null
        ? undefined
        : { ttlSegundos: cliente.accessTokenTtlSegundos },
    );

    // Sem refresh token (RFC 6749 §4.4.3): o cliente tem credencial própria e reautentica
    // quando quiser. Um refresh só acrescentaria um segredo de longa duração para vazar.
    return {
      accessToken: emitido.token,
      tokenType: 'Bearer',
      expiresIn: emitido.ttlSegundos,
      scope: escopo,
    };
  }

  /**
   * `password`: o cliente apresenta a credencial do usuário. Delega ao login por senha — que
   * já tem hash fantasma, checagem de status, métrica e trilha — e injeta o rebaixamento ao
   * escopo do cliente. O usuário é o sujeito; o cliente é o teto.
   */
  async function porSenha(
    cliente: ClienteAutenticado,
    pedido: PedidoDeToken,
  ): Promise<TokenConcedido> {
    if (!deps.passwordGrantHabilitado) {
      throw new ErroDeOAuth('unsupported_grant_type');
    }
    if (pedido.username === undefined || pedido.password === undefined) {
      throw new ErroDeOAuth('invalid_request', 'Informe username e password.');
    }

    // O escopo só é conhecido depois que as permissões do usuário são lidas, lá dentro do
    // login; guardá-lo aqui evita devolver o par de tokens sem saber o que foi concedido.
    let escopo = '';

    try {
      const par = await deps.authService.login(
        { email: pedido.username, senha: pedido.password },
        {
          restringirAutoridade: (permissoesDoUsuario) => {
            const concedido = calcularEscopoConcedido({
              solicitados: pedido.escoposSolicitados,
              escoposDoCliente: cliente.escopos,
              autoridadeDoSujeito: permissoesDoUsuario,
            });
            escopo = formatarEscopo(concedido);
            return { permissoes: concedido, escopo };
          },
          clientId: cliente.clientId,
          ...(cliente.accessTokenTtlSegundos === null
            ? {}
            : { ttlSegundos: cliente.accessTokenTtlSegundos }),
        },
      );

      return {
        accessToken: par.accessToken,
        tokenType: 'Bearer',
        expiresIn: par.expiraEmSegundos,
        scope: escopo,
        refreshToken: par.refreshToken,
      };
    } catch (erro) {
      // `invalid_scope` vem do rebaixamento e é erro de configuração — precisa chegar ao
      // cliente como tal. Falha de credencial é sempre `invalid_grant`, o mesmo para usuário
      // inexistente, senha errada e conta bloqueada.
      if (erro instanceof ErroDeOAuth) {
        throw erro;
      }
      throw new ErroDeOAuth('invalid_grant');
    }
  }

  /**
   * `refresh_token`: delega a rotação, que traz consigo o uso único, a detecção de reuso e o
   * vínculo com o cliente. O recorte reaplica o teto da emissão original — a RFC 6749 §6
   * proíbe a renovação ampliar o que foi concedido.
   */
  async function porRefresh(
    cliente: ClienteAutenticado,
    pedido: PedidoDeToken,
  ): Promise<TokenConcedido> {
    if (pedido.refreshToken === undefined) {
      throw new ErroDeOAuth('invalid_request', 'Informe refresh_token.');
    }

    let escopo = '';

    try {
      const par = await deps.refreshTokenService.rotacionar(pedido.refreshToken, {
        clientIdEsperado: cliente.clientId,
        restringirAutoridade: ({ permissoesDoUsuario, escopoOriginal }) => {
          // Sem escopo gravado (família anterior a esta SPEC), o teto volta a ser o do
          // cliente — que é o mesmo limite que valia quando o token foi emitido.
          const teto =
            escopoOriginal === null
              ? cliente.escopos
              : escopoOriginal.split(' ').filter((parte) => parte.length > 0);
          const concedido = calcularEscopoConcedido({
            solicitados: pedido.escoposSolicitados,
            escoposDoCliente: teto,
            autoridadeDoSujeito: permissoesDoUsuario,
          });
          escopo = formatarEscopo(concedido);
          return { permissoes: concedido, escopo };
        },
        ...(cliente.accessTokenTtlSegundos === null
          ? {}
          : { ttlSegundos: cliente.accessTokenTtlSegundos }),
      });

      return {
        accessToken: par.accessToken,
        tokenType: 'Bearer',
        expiresIn: par.expiraEmSegundos,
        scope: escopo,
        refreshToken: par.refreshToken,
      };
    } catch (erro) {
      if (erro instanceof ErroDeOAuth) {
        throw erro;
      }
      if (erro instanceof ErroDeRefreshInvalido && erro.motivo === 'cliente_divergente') {
        // Token de uma família que não é deste cliente: ou vazou entre integrações, ou
        // alguém está testando tokens alheios. Contador próprio, porque merece alerta.
        medidor.contarDescasamentoDeCliente();
      }
      // Ausente, expirado, reusado, de outro cliente: tudo é `invalid_grant`. O motivo real
      // fica na métrica e no log do módulo de refresh.
      throw new ErroDeOAuth('invalid_grant');
    }
  }

  async function despachar(pedido: PedidoDeToken): Promise<TokenConcedido> {
    const cliente = await autorizarCliente(pedido);

    if (pedido.grantType === 'client_credentials') {
      return porCredenciaisDoCliente(cliente, pedido.escoposSolicitados);
    }

    if (pedido.grantType === 'password') {
      return porSenha(cliente, pedido);
    }

    return porRefresh(cliente, pedido);
  }

  return {
    async emitir(pedido: PedidoDeToken): Promise<TokenConcedido> {
      const inicio = Date.now();

      try {
        const concedido = await despachar(pedido);

        medidor.contarEmissao(pedido.grantType);
        medidor.observarDuracao(pedido.grantType, (Date.now() - inicio) / 1000);
        await auditoria.registrar({
          type: 'iam.oauth.token_issued',
          actor: { id: pedido.credencial.clientId, type: 'client' },
          outcome: 'success',
          metadata: { grant_type: pedido.grantType, scope: concedido.scope },
        });
        return concedido;
      } catch (erro) {
        const codigo = erro instanceof ErroDeOAuth ? erro.codigo : 'invalid_request';
        medidor.contarRecusa(pedido.grantType, codigo);
        medidor.observarDuracao(pedido.grantType, (Date.now() - inicio) / 1000);
        // O identificador entra na trilha mesmo quando o cliente não existe: aqui ele é o
        // que foi tentado, e contar tentativas contra identificadores inventados é
        // justamente o sinal de varredura que a detecção de eventos procura.
        await auditoria.registrar({
          type: 'iam.oauth.token_denied',
          actor: { id: pedido.credencial.clientId, type: 'client' },
          outcome: 'failure',
          metadata: { grant_type: pedido.grantType, erro: codigo },
        });
        throw erro;
      }
    },
  };
}
