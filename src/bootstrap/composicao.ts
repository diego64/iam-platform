/**
 * Responsabilidade: o composition root — construir, num lugar só, todos os serviços da
 * aplicação a partir da configuração e das conexões já abertas no boot.
 * Consumido por: `server.ts` (uma vez, na subida) e os apps dos testes de integração.
 * Regras:
 *  - Fiação e nada mais: não abre conexão, não lê `process.env`, não registra rota.
 *  - Cada dependência compartilhada é construída UMA vez. Dois `verificarAccessToken`
 *    seriam dois caches de chave, capazes de divergir no meio de uma rotação; dois
 *    repositórios de associação, dois caminhos para a mesma escrita.
 *  - O que sai daqui é exatamente o que `app.ts` precisa para registrar cada módulo — o
 *    formato dos objetos é o das dependências de rota, para não haver tradução no meio.
 */
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import type { Env } from '../config/env.js';
import type { Logger } from '../shared/logger/index.js';
import { criarServicoDeSenhaDaEnv } from '../shared/crypto/password.service.js';
import {
  criarAuthService,
  criarMedidorDeAuth,
  criarRepositorioDeAutenticacao,
  criarRepositorioDeDenylist,
  criarTokenService,
  criarVerificadorDeAccessToken,
  idAutenticado,
  type DependenciasDasRotasDeAuth,
} from '../modules/auth/index.js';
import {
  criarMedidorDeRefresh,
  criarRefreshTokenService,
  criarRepositorioDeRefreshToken,
  type DependenciasDasRotasDeRefresh,
} from '../modules/refresh-token/index.js';
import { criarPasswordService } from '../modules/password/services/password.service.js';
import { criarRepositorioDeTokenDeReset } from '../modules/password/repositories/reset-token.repository.js';
import { criarRepositorioDeHistorico } from '../modules/password/repositories/password-history.repository.js';
import { criarCanalDeLog } from '../modules/password/services/canal-de-log.js';
import type { DependenciasDoController as DependenciasDeSenha } from '../modules/password/index.js';
import {
  criarMedidorDeUsuarios,
  criarRepositorioDeUsuario,
  criarUserService,
  type AutorizadorAdmin,
  type DependenciasDoController as DependenciasDeUsuarios,
  type RevogadorDeSessoes,
} from '../modules/users/index.js';
import {
  criarAssignmentService,
  criarGuardsDeAutorizacao,
  criarMedidorDeRbac,
  criarRbacService,
  criarRepositorioDeAssociacao,
  criarRepositorioDePapel,
  criarRepositorioDePermissao,
  satisfaz,
  type DependenciasDasRotasDeRbac,
} from '../modules/rbac/index.js';
import {
  criarAbacService,
  criarMedidorDeAbac,
  criarMotorDePoliticas,
  criarRepositorioDePolitica,
  type DependenciasDasRotasDeAbac,
} from '../modules/abac/index.js';
import {
  criarApiClientService,
  criarCatalogoDeEscopos,
  criarMedidorDeClientes,
  criarRepositorioDeClientes,
  criarResolvedorDeEscopos,
} from '../modules/api-clients/index.js';
import type { DependenciasDasRotasDeClientes } from '../modules/api-clients/routes/api-client.routes.js';
import {
  criarKeyRotationService,
  criarMedidorDeJwks,
  type JwksService,
  type RepositorioJwks,
} from '../modules/jwks/index.js';
import type { DependenciasDasRotasDeChaves } from '../modules/jwks/routes/keys-admin.routes.js';

/**
 * Permissão exigida pelas rotas administrativas de usuário.
 *
 * A porta `AutorizadorAdmin` é uma só para as sete rotas, então a checagem tem de cobrir a
 * mais privilegiada delas — criar, bloquear e remover são escrita. O curinga `*` do
 * superadmin satisfaz esta verificação, como satisfaz qualquer outra.
 *
 * ponytail: uma permissão para as sete. Separar leitura de escrita exige a porta virar
 * duas, e é decisão do painel administrativo (SPEC 018), não desta fiação.
 */
const PERMISSAO_DE_ADMINISTRACAO_DE_USUARIOS = 'users:write';

export interface DependenciasDaComposicao {
  readonly env: Env;
  readonly pool: Pool;
  readonly banco: Db;
  /** Serviço de chaves **já iniciado**: quem decifra a chave ativa é o boot, antes daqui. */
  readonly jwks: JwksService;
  /** Repositório de chaves, construído no boot porque o `jwks` acima já depende dele. */
  readonly repoJwks: RepositorioJwks;
  readonly logger: Logger;
  /** Liga os medidores OpenTelemetry. Ausente ⇒ medidores nulos (testes, app sem telemetria). */
  readonly metricas?: boolean;
}

/**
 * Os serviços de cada módulo, no formato que a função de registro de rota consome.
 *
 * `chaves` é opcional porque a rotação precisa da `MASTER_KEY` para cifrar a privada da
 * chave nova: sem o segredo não existe serviço de rotação, e as rotas administrativas de
 * chave não sobem.
 */
export interface ModulosDaAplicacao {
  readonly auth: DependenciasDasRotasDeAuth;
  readonly refresh: DependenciasDasRotasDeRefresh;
  readonly password: DependenciasDeSenha;
  readonly users: DependenciasDeUsuarios;
  readonly rbac: DependenciasDasRotasDeRbac;
  readonly abac: DependenciasDasRotasDeAbac;
  readonly clientes: DependenciasDasRotasDeClientes;
  readonly chaves?: DependenciasDasRotasDeChaves;
}

/**
 * Decide se o já-autenticado pode administrar usuários.
 *
 * Roda depois do `verificarAccessToken`, que é quem popula `requisicao.usuario`. Sem
 * usuário na requisição a resposta é `sem-token` — fail closed: a ausência é tratada como
 * recusa, nunca como "ninguém checou, então deixa passar".
 */
function criarAutorizadorDeAdministracao(): AutorizadorAdmin {
  return (requisicao) => {
    const usuario = requisicao.usuario;
    if (usuario === undefined) return { ok: false, motivo: 'sem-token' };

    return satisfaz(PERMISSAO_DE_ADMINISTRACAO_DE_USUARIOS, usuario.permissions)
      ? { ok: true, adminId: usuario.id }
      : { ok: false, motivo: 'sem-permissao' };
  };
}

export function construirModulos(deps: DependenciasDaComposicao): ModulosDaAplicacao {
  const { env, pool, banco, jwks, repoJwks, logger } = deps;
  const metricas = deps.metricas ?? false;

  // ---- Compartilhados: construídos aqui uma vez e reusados por todos os módulos ----
  const servicoDeSenha = criarServicoDeSenhaDaEnv(env);
  const repoAuth = criarRepositorioDeAutenticacao(pool);
  const repoUsuarios = criarRepositorioDeUsuario(pool);
  const repoAssociacoes = criarRepositorioDeAssociacao(pool);
  const repoRefresh = criarRepositorioDeRefreshToken(banco);
  const denylist = criarRepositorioDeDenylist(banco);

  const tokenService = criarTokenService(jwks, {
    emissor: env.JWT_ISSUER,
    audiencia: env.JWT_AUDIENCE,
    ttlSegundos: env.ACCESS_TOKEN_TTL_SECONDS,
  });

  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: env.JWT_ISSUER,
    audiencia: env.JWT_AUDIENCE,
  });

  const guards = criarGuardsDeAutorizacao(metricas ? { medidor: criarMedidorDeRbac() } : {});

  const refreshTokenService = criarRefreshTokenService({
    repo: repoRefresh,
    usuarios: repoAuth,
    tokenService,
    ttlIdleMs: env.REFRESH_TOKEN_TTL_MS,
    ttlAbsolutoMs: env.REFRESH_TOKEN_ABSOLUTE_TTL_MS,
    graceMs: env.REFRESH_REUSE_GRACE_MS,
    ...(metricas ? { medidor: criarMedidorDeRefresh() } : {}),
  });

  /**
   * Concreto das portas de revogação de sessão, que bloqueio, remoção e troca de senha
   * consomem. Derruba os refresh tokens do usuário: é o que existe hoje de sessão
   * persistida, e é o que impede a sessão de ser reconstruída depois da reação.
   *
   * ponytail: o access token já emitido sobrevive até expirar (15 min). Fechar essa janela
   * é denylist por usuário — modelo da SPEC 006, não desta fiação.
   */
  const sessoes: RevogadorDeSessoes = {
    revogarTodas: (userId) => repoRefresh.revogarDoUsuario(userId),
  };

  const authService = criarAuthService({
    repo: repoAuth,
    servicoDeSenha,
    tokenService,
    refreshToken: refreshTokenService,
    denylist,
    ...(metricas ? { medidor: criarMedidorDeAuth() } : {}),
  });

  const passwordService = criarPasswordService({
    servicoDeSenha,
    usuarios: repoUsuarios,
    tokensDeReset: criarRepositorioDeTokenDeReset(banco),
    historico: criarRepositorioDeHistorico(pool),
    sessoes,
    notificacao: criarCanalDeLog(logger),
    ttlResetMin: 30,
    historicoN: 3,
  });

  const repoPoliticas = criarRepositorioDePolitica(pool);
  const motor = criarMotorDePoliticas({
    politicas: repoPoliticas,
    ...(metricas ? { medidor: criarMedidorDeAbac() } : {}),
  });

  const clienteService = criarApiClientService({
    repo: criarRepositorioDeClientes(pool),
    escopos: criarResolvedorDeEscopos(criarCatalogoDeEscopos(pool)),
    servicoDeSenha,
    logger,
    sobreposicaoPadraoMs: env.CLIENT_SECRET_OVERLAP_DEFAULT_MS,
    ...(metricas ? { medidor: criarMedidorDeClientes() } : {}),
  });

  const rotacao =
    env.MASTER_KEY === undefined
      ? undefined
      : criarKeyRotationService({
          repo: repoJwks,
          masterKey: env.MASTER_KEY,
          logger,
          invalidarCache: () => {
            jwks.invalidar();
          },
          graceMs: env.JWKS_GRACE_PERIOD_MS,
          prepublicacaoMinMs: env.JWKS_PREPUBLISH_MIN_MS,
          purgaAposMs: env.JWKS_PURGE_AFTER_MS,
          ...(metricas ? { medidor: criarMedidorDeJwks() } : {}),
        });

  return {
    auth: { authService, verificarAccessToken },
    refresh: { refreshTokenService },
    password: { passwordService, autenticar: idAutenticado },
    users: {
      userService: criarUserService({ repositorio: repoUsuarios, servicoDeSenha, sessoes }),
      autorizador: criarAutorizadorDeAdministracao(),
      ...(metricas ? { medidor: criarMedidorDeUsuarios() } : {}),
    },
    rbac: {
      rbacService: criarRbacService({
        papeis: criarRepositorioDePapel(pool),
        permissoes: criarRepositorioDePermissao(pool),
        associacoes: repoAssociacoes,
      }),
      assignmentService: criarAssignmentService({ associacoes: repoAssociacoes }),
      guards,
      verificarAccessToken,
    },
    abac: {
      abacService: criarAbacService({ politicas: repoPoliticas, motor }),
      motor,
      guards,
      verificarAccessToken,
    },
    clientes: {
      service: clienteService,
      sobreposicaoPadraoMs: env.CLIENT_SECRET_OVERLAP_DEFAULT_MS,
      guards,
      verificarAccessToken,
    },
    ...(rotacao === undefined
      ? {}
      : { chaves: { rotacao, repo: repoJwks, guards, verificarAccessToken } }),
  };
}
