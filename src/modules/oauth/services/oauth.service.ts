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

const GRANTS_CONHECIDOS: readonly TipoDeGrant[] = [
  'client_credentials',
  'password',
  'refresh_token',
];

export interface PedidoDeToken {
  readonly grantType: string;
  readonly credencial: CredencialDeCliente;
  readonly escoposSolicitados?: readonly string[] | undefined;
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
}

export interface OAuthService {
  emitir(pedido: PedidoDeToken): Promise<TokenConcedido>;
}

function ehGrantConhecido(valor: string): valor is TipoDeGrant {
  return (GRANTS_CONHECIDOS as readonly string[]).includes(valor);
}

export function criarOAuthService(deps: DependenciasDoOAuthService): OAuthService {
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

  return {
    async emitir(pedido: PedidoDeToken): Promise<TokenConcedido> {
      const cliente = await autorizarCliente(pedido);

      if (pedido.grantType === 'client_credentials') {
        return porCredenciaisDoCliente(cliente, pedido.escoposSolicitados);
      }

      throw new ErroDeOAuth('unsupported_grant_type');
    },
  };
}
