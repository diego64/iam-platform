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

export interface AuthService {
  login(credenciais: Credenciais): Promise<ParDeTokens>;
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
    async login(credenciais: Credenciais): Promise<ParDeTokens> {
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
      const emitido = await deps.tokenService.emitir({
        sub: usuario.id,
        roles,
        permissions,
        scope,
      });
      const refreshToken = await deps.refreshToken.emitir(usuario.id);

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
