/**
 * Responsabilidade: orquestrar login, logout e perfil.
 * Consumido por: o controller das rotas de auth.
 * Regras:
 *  - Falha de login sempre genérica (`credencial-invalida`): usuário inexistente, senha
 *    errada e conta bloqueada são indistinguíveis na resposta; o motivo fica só na métrica.
 *  - Usuário inexistente ainda paga uma verificação contra um hash fantasma, para o tempo
 *    de resposta não denunciar a ausência da conta (mitiga enumeração por timing).
 *  - Nenhum banco nem Fastify aqui: repositórios, serviço de senha, emissor de token e
 *    denylist entram por injeção.
 */
import { ErroDeAutenticacao } from '../errors/auth-error.js';
import type { ParDeTokens } from '../types/auth.types.js';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { RepositorioDeAutenticacao } from '../repositories/auth-user.repository.js';
import type { RepositorioDeDenylist } from '../repositories/token-denylist.repository.js';
import type { PortaDeRefreshToken } from '../interfaces/refresh-token.port.js';
import type { TokenService } from './token.service.js';
import { medidorDeAuthNulo, type MedidorDeAuth } from '../metrics/auth.metrics.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';

export interface Credenciais {
  readonly email: string;
  readonly senha: string;
}

export interface DadosDeLogout {
  readonly jti: string;
  readonly userId: string;
  readonly expiraEm: Date;
  readonly refreshToken?: string;
}

export interface PerfilDoUsuario {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly roles: string[];
}

export interface DependenciasDoAuthService {
  readonly repo: RepositorioDeAutenticacao;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly tokenService: TokenService;
  readonly refreshToken: PortaDeRefreshToken;
  readonly denylist: RepositorioDeDenylist;
  readonly medidor?: MedidorDeAuth;
  /** Scope padrão dos tokens emitidos no login por senha. */
  readonly scopePadrao?: string;
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
}

/** Autoridade final do token, depois de qualquer recorte de quem pediu a emissão. */
export interface AutoridadeConcedida {
  readonly permissoes: readonly string[];
  /** Formato da claim `scope`: nomes separados por espaço. */
  readonly escopo: string;
}

export interface OpcoesDeLogin {
  /**
   * Recorta a autoridade do token a partir das permissões efetivas do usuário.
   *
   * Existe para a emissão por OAuth rebaixar o token ao escopo do cliente sem que este
   * serviço precise conhecer cliente, escopo ou protocolo: ele entrega as permissões e
   * recebe de volta o que vai no token. O login por senha não passa nada e o usuário sai
   * com tudo o que tem — o comportamento de sempre.
   *
   * Quem precisa saber o que foi concedido guarda o resultado no próprio recorte; por isso
   * o par de tokens devolvido continua com a forma de antes desta SPEC.
   */
  readonly restringirAutoridade?: (permissoesDoUsuario: readonly string[]) => AutoridadeConcedida;
  /** Sobrepõe o TTL global do access token (o do cliente, na emissão por OAuth). */
  readonly ttlSegundos?: number;
  /**
   * Cliente que pediu a emissão. Vai para o token e para o vínculo do refresh — sem ele, o
   * refresh nasceria solto e nenhum cliente conseguiria renová-lo.
   */
  readonly clientId?: string;
}

export interface AuthService {
  login(credenciais: Credenciais, opcoes?: OpcoesDeLogin): Promise<ParDeTokens>;
  logout(dados: DadosDeLogout): Promise<void>;
  perfil(userId: string): Promise<PerfilDoUsuario | null>;
}

export function criarAuthService(deps: DependenciasDoAuthService): AuthService {
  const medidor = deps.medidor ?? medidorDeAuthNulo();
  const auditoria = deps.auditoria ?? registradorNulo();
  const scope = deps.scopePadrao ?? '';

  /**
   * A trilha registra a tentativa falha sem dizer qual conta existe.
   *
   * A resposta ao cliente é genérica por design, e a trilha não pode desfazer isso guardando
   * o e-mail digitado — que, num ataque de enumeração, é e-mail de terceiro. O que vai é a
   * pista derivada, suficiente para contar tentativas contra o mesmo alvo.
   */
  async function registrarFalha(email: string, atorId: string | null): Promise<void> {
    await auditoria.registrar({
      type: 'iam.auth.login_failed',
      actor: { id: atorId, type: 'user' },
      outcome: 'failure',
      reason: 'invalid_credentials',
      subjectEmail: email,
    });
  }

  return {
    async login(credenciais: Credenciais, opcoes?: OpcoesDeLogin): Promise<ParDeTokens> {
      const usuario = await deps.repo.buscarPorEmail(credenciais.email);

      if (usuario === null) {
        // Paga a verificação contra o hash fantasma para equalizar o tempo de resposta.
        await deps.servicoDeSenha.verificar(
          credenciais.senha,
          await deps.servicoDeSenha.hashFantasma(),
        );
        medidor.contarFalha('desconhecido');
        await registrarFalha(credenciais.email, null);
        throw new ErroDeAutenticacao('credencial-invalida');
      }

      const senhaConfere = await deps.servicoDeSenha.verificar(
        credenciais.senha,
        usuario.passwordHash,
      );
      if (!senhaConfere) {
        medidor.contarFalha('senha');
        await registrarFalha(credenciais.email, usuario.id);
        throw new ErroDeAutenticacao('credencial-invalida');
      }

      if (usuario.status !== 'active') {
        medidor.contarFalha('bloqueado');
        await auditoria.registrar({
          type: 'iam.auth.login_failed',
          actor: { id: usuario.id, type: 'user' },
          outcome: 'failure',
          reason: 'account_blocked',
        });
        throw new ErroDeAutenticacao('credencial-invalida');
      }

      const [roles, permissions] = await Promise.all([
        deps.repo.papeisDoUsuario(usuario.id),
        deps.repo.permissoesEfetivas(usuario.id),
      ]);
      // Sem recorte, o token carrega a autoridade inteira do usuário e o escopo padrão.
      const concedida: AutoridadeConcedida = opcoes?.restringirAutoridade?.(permissions) ?? {
        permissoes: permissions,
        escopo: scope,
      };
      const emitido = await deps.tokenService.emitir(
        {
          sub: usuario.id,
          roles,
          permissions: [...concedida.permissoes],
          scope: concedida.escopo,
          // `sub_type` só aparece quando a emissão passou por um cliente: um consumidor que
          // recebe token de duas origens precisa saber que ali há uma pessoa por trás. O
          // token do login por senha continua sem a claim.
          ...(opcoes?.clientId === undefined
            ? {}
            : { clientId: opcoes.clientId, subType: 'user' as const }),
        },
        opcoes?.ttlSegundos === undefined ? undefined : { ttlSegundos: opcoes.ttlSegundos },
      );
      const refreshToken = await deps.refreshToken.emitir(
        usuario.id,
        opcoes?.clientId === undefined
          ? undefined
          : { clientId: opcoes.clientId, escopo: concedida.escopo },
      );

      medidor.contarSucesso();
      await auditoria.registrar({
        type: 'iam.auth.login',
        actor: { id: usuario.id, type: 'user' },
        outcome: 'success',
      });
      return {
        accessToken: emitido.token,
        refreshToken,
        expiraEmSegundos: emitido.ttlSegundos,
      };
    },

    async logout(dados: DadosDeLogout): Promise<void> {
      await deps.denylist.revogar({
        jti: dados.jti,
        userId: dados.userId,
        motivo: 'logout',
        expiraEm: dados.expiraEm,
      });
      if (dados.refreshToken !== undefined) {
        await deps.refreshToken.revogar(dados.refreshToken);
      }
      await auditoria.registrar({
        type: 'iam.auth.logout',
        actor: { id: dados.userId, type: 'user' },
        outcome: 'success',
        reason: 'self_service',
      });
    },

    async perfil(userId: string): Promise<PerfilDoUsuario | null> {
      const usuario = await deps.repo.buscarPorId(userId);
      if (usuario === null) return null;
      const roles = await deps.repo.papeisDoUsuario(userId);
      return { id: usuario.id, email: usuario.email, status: usuario.status, roles };
    },
  };
}
