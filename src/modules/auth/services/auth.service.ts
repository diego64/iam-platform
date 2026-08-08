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
import type { ParDeTokens, ResultadoDeLogin } from '../types/auth.types.js';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { RepositorioDeAutenticacao } from '../repositories/auth-user.repository.js';
import type { RepositorioDeDenylist } from '../repositories/token-denylist.repository.js';
import type { PortaDeRefreshToken } from '../interfaces/refresh-token.port.js';
import type { MetodoDeMfa, PortaDeMfa, RespostaAoDesafio } from '../interfaces/mfa.port.js';
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
  /**
   * Segundo fator. Ausente, o login é de um passo só — exatamente o comportamento de antes
   * de existir MFA, e é isso que mantém a suíte da SPEC 001 válida sem edição.
   */
  readonly mfa?: PortaDeMfa;
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
  /**
   * Autentica a senha. Devolve o par de tokens quando a conta não tem segundo fator, ou o
   * desafio quando tem — os dois são caminho feliz.
   */
  login(credenciais: Credenciais, opcoes?: OpcoesDeLogin): Promise<ResultadoDeLogin>;
  /** Troca um desafio resolvido pelo par de tokens. */
  concluirDesafio(
    mfaToken: string,
    resposta: RespostaAoDesafio,
    opcoes?: OpcoesDeLogin,
  ): Promise<ParDeTokens>;
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

  /**
   * A cauda comum das duas portas de entrada: recarrega papéis e permissões, aplica o
   * recorte de autoridade, assina o token e emite o refresh.
   *
   * Existe uma vez só de propósito. Com duas cópias, a próxima claim nasceria num caminho e
   * faltaria no outro — e o caminho esquecido seria justamente o do segundo fator, que é
   * usado por menos gente e demoraria a aparecer.
   */
  async function emitirPar(
    userId: string,
    opcoes: OpcoesDeLogin | undefined,
    metodo: MetodoDeMfa | null,
  ): Promise<ParDeTokens> {
    const [roles, permissions] = await Promise.all([
      deps.repo.papeisDoUsuario(userId),
      deps.repo.permissoesEfetivas(userId),
    ]);
    // Sem recorte, o token carrega a autoridade inteira do usuário e o escopo padrão.
    const concedida: AutoridadeConcedida = opcoes?.restringirAutoridade?.(permissions) ?? {
      permissoes: permissions,
      escopo: scope,
    };
    const emitido = await deps.tokenService.emitir(
      {
        sub: userId,
        roles,
        permissions: [...concedida.permissoes],
        scope: concedida.escopo,
        // `sub_type` só aparece quando a emissão passou por um cliente: um consumidor que
        // recebe token de duas origens precisa saber que ali há uma pessoa por trás. O
        // token do login por senha continua sem a claim.
        ...(opcoes?.clientId === undefined
          ? {}
          : { clientId: opcoes.clientId, subType: 'user' as const }),
        // `amr`/`mfa` idem: só existem quando houve segundo fator.
        ...(metodo === null ? {} : { amr: ['pwd', metodo], mfa: true }),
      },
      opcoes?.ttlSegundos === undefined ? undefined : { ttlSegundos: opcoes.ttlSegundos },
    );
    const refreshToken = await deps.refreshToken.emitir(userId, {
      ...(opcoes?.clientId === undefined
        ? {}
        : { clientId: opcoes.clientId, escopo: concedida.escopo }),
      ...(metodo === null ? {} : { amr: ['pwd', metodo] }),
    });

    return {
      accessToken: emitido.token,
      refreshToken,
      expiraEmSegundos: emitido.ttlSegundos,
    };
  }

  return {
    async login(credenciais: Credenciais, opcoes?: OpcoesDeLogin): Promise<ResultadoDeLogin> {
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

      // Senha correta e conta ativa: daqui em diante o login ou termina, ou para no
      // segundo fator. A porta ausente é o caminho de quem não tem MFA instalado.
      const desafio = (await deps.mfa?.desafiar(usuario.id)) ?? null;
      if (desafio !== null) {
        return {
          mfaRequerido: true,
          mfaToken: desafio.token,
          expiraEmSegundos: desafio.expiraEmSegundos,
        };
      }

      const par = await emitirPar(usuario.id, opcoes, null);

      medidor.contarSucesso();
      await auditoria.registrar({
        type: 'iam.auth.login',
        actor: { id: usuario.id, type: 'user' },
        outcome: 'success',
      });
      return par;
    },

    async concluirDesafio(mfaToken, resposta, opcoes): Promise<ParDeTokens> {
      const resolvido = (await deps.mfa?.resolver(mfaToken, resposta)) ?? null;
      if (resolvido === null) {
        // Desafio inexistente, expirado, esgotado ou resposta errada: uma resposta só.
        medidor.contarFalha('mfa');
        await auditoria.registrar({
          type: 'iam.mfa.failed',
          actor: { id: null, type: 'user' },
          outcome: 'failure',
          reason: 'invalid_credentials',
        });
        throw new ErroDeAutenticacao('desafio-mfa-invalido');
      }

      // O usuário é relido aqui: entre a senha e o segundo fator dá tempo de a conta ser
      // bloqueada, e o desafio não pode virar um passe livre por cinco minutos.
      const usuario = await deps.repo.buscarPorId(resolvido.userId);
      if (usuario === null || usuario.status !== 'active') {
        medidor.contarFalha('bloqueado');
        throw new ErroDeAutenticacao('credencial-invalida');
      }

      const par = await emitirPar(resolvido.userId, opcoes, resolvido.metodo);

      medidor.contarSucesso();
      await auditoria.registrar({
        type: resolvido.metodo === 'recovery' ? 'iam.mfa.recovery_used' : 'iam.mfa.verified',
        actor: { id: resolvido.userId, type: 'user' },
        outcome: 'success',
      });
      return par;
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
