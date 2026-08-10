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
import type { FastifyReply } from 'fastify';
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import type { Env } from '../config/env.js';
import type { Logger } from '../shared/logger/index.js';
import { criarServicoDeSenhaDaEnv } from '../shared/crypto/password.service.js';
import { criarContadorEmMemoria } from '../shared/rate-limit/memory-store.js';
import { criarContadorNoMongo } from '../shared/rate-limit/mongo-store.js';
import { criarPoliticaDeRateLimit } from '../shared/rate-limit/politica.js';
import { criarHookDeLimitePorIdentidade } from '../shared/rate-limit/hook-por-identidade.js';
import { criarMedidorDeRateLimit } from '../shared/rate-limit/rate-limit.metrics.js';
import { problemaDeRateLimit } from '../shared/rate-limit/resposta-429.js';
import {
  criarCanalDeLog as criarCanalDeAlertaEmLog,
  criarDetector,
  criarExtratorDeSujeito,
  criarMedidorDeSeguranca,
  criarRegistradorComDeteccao,
  criarRepositorioDeConjuntoDistinto,
  criarRepositorioDeEventosDeSeguranca,
  type CanalDeAlerta,
  type DependenciasDasRotasDeSeguranca,
} from '../modules/security-events/index.js';
import { clientIdApresentado } from '../modules/oauth/services/client-credentials.js';
import type { ContadorDeRateLimit } from '../shared/rate-limit/types.js';
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
import {
  criarCanalDeEmail,
  criarMedidorDeNotificacoes,
  criarNotificador,
  criarRegistradorComNotificacao,
  criarRepositorioDeDispositivos,
  criarResolvedorDeDestinatario,
  criarServicoDeNotificacao,
  criarTransporteDeLog,
  criarTransporteHttp,
  criarCanalDeReset,
  type DependenciasDasRotasDeNotificacoes,
  type TransportadorDeEmail,
} from '../modules/notifications/index.js';
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
  criarClientAuthService,
  criarMedidorDeClientes,
  criarRepositorioDeClientes,
  criarResolvedorDeEscopos,
} from '../modules/api-clients/index.js';
import type { DependenciasDasRotasDeClientes } from '../modules/api-clients/routes/api-client.routes.js';
import {
  criarMedidorDeMfa,
  criarMfaService,
  criarRepositorioDeCodigosDeRecuperacao,
  criarRepositorioDeDesafioDeMfa,
  criarRepositorioDeFatorDeMfa,
  criarServicoDeDesafioDeMfa,
  digerirTokenDeDesafio,
  type DependenciasDasRotasDeMfa,
} from '../modules/mfa/index.js';
import {
  criarMedidorDeOAuth,
  criarMetadataService,
  criarOAuthService,
  type DependenciasDasRotasDeMetadados,
  type DependenciasDasRotasDeOAuth,
} from '../modules/oauth/index.js';
import {
  criarKeyRotationService,
  criarMedidorDeJwks,
  type JwksService,
  type RepositorioJwks,
} from '../modules/jwks/index.js';
import type { DependenciasDasRotasDeChaves } from '../modules/jwks/routes/keys-admin.routes.js';
import {
  criarAuditIntegrityService,
  criarAuditQueryService,
  criarAuditService,
  criarMedidorDeAuditoria,
  criarRepositorioDaTrilha,
  criarRepositorioDeCheckpoint,
  type DependenciasDasRotasDeAuditoria,
  type RegistradorDeAuditoria,
} from '../modules/audit/index.js';

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

/** Validade do token de reset. O e-mail precisa dizer o mesmo número que o serviço aplica. */
const TTL_RESET_MIN = 30;

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
/** O que o app precisa para compartilhar o contador de rate limit entre as réplicas. */
export interface RateLimitDaAplicacao {
  readonly contador: ContadorDeRateLimit;
  readonly pepper: string;
  /** Teto por IP estourado — a dimensão que o plugin decide sozinho. */
  readonly aoExcederPorIp?: () => void;
}

export interface ModulosDaAplicacao {
  /** Contador compartilhado, entregue ao plugin de rate limit pelo `app.ts`. */
  readonly rateLimit: RateLimitDaAplicacao;
  readonly auth: DependenciasDasRotasDeAuth;
  readonly refresh: DependenciasDasRotasDeRefresh;
  readonly oauth: DependenciasDasRotasDeOAuth;
  /**
   * Ausente sem `MASTER_KEY`: sem ela não há como cifrar o segredo TOTP em repouso, e um
   * IdP que guardasse esse segredo em claro por falta de variável de ambiente seria pior
   * que um IdP sem segundo fator. Mesma regra que já vale para a rotação de chaves.
   */
  readonly mfa?: DependenciasDasRotasDeMfa;
  readonly metadadosDeOAuth: DependenciasDasRotasDeMetadados;
  readonly senha: DependenciasDeSenha;
  readonly users: DependenciasDeUsuarios;
  readonly rbac: DependenciasDasRotasDeRbac;
  readonly abac: DependenciasDasRotasDeAbac;
  readonly clientes: DependenciasDasRotasDeClientes;
  readonly chaves?: DependenciasDasRotasDeChaves;
  readonly auditoria: DependenciasDasRotasDeAuditoria;
  readonly seguranca: DependenciasDasRotasDeSeguranca;
  readonly notificacoes: DependenciasDasRotasDeNotificacoes;
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

/**
 * Segredo que entra no hash do e-mail nos eventos sem ator identificado.
 *
 * Fora de produção, um valor fixo e declaradamente de desenvolvimento: sem ele o serviço não
 * sobe, e exigir segredo para rodar `pnpm dev` só levaria a inventar um pior. Em produção,
 * a ausência derruba o boot — a pista sem pepper é reversível por dicionário de e-mails, que
 * é exatamente o que ela existe para impedir.
 */
const PEPPER_DE_DESENVOLVIMENTO = 'pepper-de-desenvolvimento-nao-use-em-producao';

function exigirPepper(env: Env): string {
  if (env.AUDIT_HINT_PEPPER !== undefined) return env.AUDIT_HINT_PEPPER;
  if (env.NODE_ENV === 'production') {
    throw new Error('AUDIT_HINT_PEPPER ausente: a trilha de auditoria não sobe sem ele');
  }
  return PEPPER_DE_DESENVOLVIMENTO;
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

  /**
   * Trilha de auditoria, construída uma vez e injetada em todos os serviços que registram.
   *
   * Um segundo registrador seria uma segunda cadeia disputando o mesmo documento de topo —
   * não quebraria a integridade, mas multiplicaria a contenção sem motivo.
   */
  const trilha = criarRepositorioDaTrilha(banco, { maxTentativas: env.AUDIT_CAS_MAX_RETRIES });
  const checkpoints = criarRepositorioDeCheckpoint(pool);
  const registradorDaTrilha: RegistradorDeAuditoria = criarAuditService({
    trilha,
    checkpoints,
    logger,
    pepper: exigirPepper(env),
    checkpointACada: env.AUDIT_CHECKPOINT_EVERY,
    ...(metricas ? { medidor: criarMedidorDeAuditoria() } : {}),
  });

  // Rate limit: um contador para a plataforma inteira, e a política que o consulta. Com o
  // contador local do plugin, o teto seria multiplicado pelo número de réplicas.
  const pepperDeLimite = exigirPepper(env);
  const medidorDeLimite = metricas ? criarMedidorDeRateLimit() : undefined;
  const contadorDeLimite =
    env.RATE_LIMIT_STORE === 'memory'
      ? criarContadorEmMemoria()
      : criarContadorNoMongo({
          banco,
          timeoutMs: env.RATE_LIMIT_STORE_TIMEOUT_MS,
          aoFalhar: () => {
            medidorDeLimite?.contarErroDoContador();
          },
        });
  /**
   * Notificação: o mesmo padrão do decorador de detecção, uma camada acima.
   *
   * O transporte de log é o default deliberado — ambiente que subiu sem provedor não manda
   * nada para a rede, em vez de falhar na primeira entrega.
   */
  const medidorDeNotificacoes = metricas ? criarMedidorDeNotificacoes() : undefined;
  // Separado do pepper da trilha de propósito: aquele é perpétuo, para não quebrar a
  // correlação histórica, e este pode ser rotacionado. Deriva tanto o digest do dispositivo
  // quanto o do destinatário no log — sem ele, o digest de um e-mail cai por dicionário.
  const pepperDeNotificacao = env.NOTIFY_DEVICE_PEPPER ?? pepperDeLimite;
  const transporte: TransportadorDeEmail =
    env.NOTIFY_TRANSPORT === 'http' &&
    env.NOTIFY_HTTP_URL !== undefined &&
    env.NOTIFY_HTTP_TOKEN !== undefined &&
    env.NOTIFY_FROM !== undefined
      ? criarTransporteHttp({
          url: env.NOTIFY_HTTP_URL,
          token: env.NOTIFY_HTTP_TOKEN,
          remetente: env.NOTIFY_FROM,
          timeoutMs: env.NOTIFY_TIMEOUT_MS,
          aoFalhar: (erro) => {
            logger.warn({ err: erro, evento: 'notification.transporte_falhou' }, 'entrega falhou');
          },
        })
      : criarTransporteDeLog(logger, pepperDeNotificacao);

  const notificacoes = criarServicoDeNotificacao({
    transporte,
    destinatarios: criarResolvedorDeDestinatario({
      pool,
      aoFalhar: (erro) => {
        logger.warn({ err: erro, evento: 'notification.destinatario_falhou' }, 'consulta falhou');
      },
    }),
    teto: contadorDeLimite,
    maxPorHora: env.NOTIFY_MAX_PER_HOUR,
    pepper: pepperDeNotificacao,
    logger,
    ...(medidorDeNotificacoes ? { medidor: medidorDeNotificacoes } : {}),
  });

  /**
   * Canal de alerta do detector: e-mail quando há endereço de operação configurado, log
   * quando não há. Sem endereço, avisar por e-mail seria mandar para lugar nenhum — e o
   * log-fallback pelo menos deixa rastro em quem coleta.
   */
  const canalDeAlerta: CanalDeAlerta =
    env.NOTIFY_OPERATOR_EMAILS.length > 0
      ? criarCanalDeEmail({
          notificacoes,
          destinatarios: env.NOTIFY_OPERATOR_EMAILS,
          severidadeMinima: env.NOTIFY_SECURITY_MIN_SEVERITY,
          aoSuprimir: () => {
            medidorDeNotificacoes?.contarSupressao('alerta_de_seguranca', 'severidade');
          },
        })
      : criarCanalDeAlertaEmLog(logger);

  const notificador = criarNotificador({
    notificacoes,
    dispositivos: criarRepositorioDeDispositivos({
      banco,
      ttlMs: env.NOTIFY_DEVICE_TTL_MS,
      pepper: pepperDeNotificacao,
    }),
    ...(medidorDeNotificacoes ? { medidor: medidorDeNotificacoes } : {}),
    aoFalhar: (erro) => {
      logger.warn({ err: erro, evento: 'notification.notificador_falhou' }, 'aviso não saiu');
    },
  });

  /**
   * O que os sete módulos recebem daqui para baixo. O nome continua `auditoria` de
   * propósito: quem injeta não precisa saber que há detecção nem notificação no caminho.
   *
   * A ordem da pilha importa: a trilha é o fato, e as duas camadas acima dela são derivadas.
   * Cada decorador aguarda o de baixo e dispara o próprio observador sem aguardar, então
   * nenhuma das duas entra no caminho crítico de quem só quer entrar.
   */
  /**
   * Detecção de eventos de segurança.
   *
   * O registrador que os sete módulos recebem é o **decorado**: ele grava na trilha e, no
   * caminho, oferece o fato às regras. Nenhum emissor sabe que a detecção existe, e o
   * módulo que alguém escrever daqui a três meses entra de graça.
   */
  const eventosDeSeguranca = criarRepositorioDeEventosDeSeguranca(banco);
  const medidorDeSeguranca = metricas ? criarMedidorDeSeguranca() : undefined;
  const detector = criarDetector({
    contexto: {
      contador: contadorDeLimite,
      conjuntos: criarRepositorioDeConjuntoDistinto({
        banco,
        tamanhoMaximo: env.SECURITY_SET_MAX,
        aoFalhar: () => {
          medidorDeSeguranca?.contarErro();
        },
      }),
      extrator: criarExtratorDeSujeito(pepperDeLimite),
      limiares: {
        bruteForceMax: env.SECURITY_BRUTE_FORCE_MAX,
        bruteForceJanelaMs: env.SECURITY_BRUTE_FORCE_WINDOW_MS,
        stuffingContasMax: env.SECURITY_STUFFING_CONTAS_MAX,
        stuffingJanelaMs: env.SECURITY_STUFFING_WINDOW_MS,
        varreduraDeClienteMax: env.SECURITY_CLIENT_SCAN_MAX,
        varreduraDeClienteJanelaMs: env.SECURITY_CLIENT_SCAN_WINDOW_MS,
        mfaFalhasMax: env.SECURITY_MFA_FAIL_MAX,
        mfaJanelaMs: env.SECURITY_MFA_FAIL_WINDOW_MS,
      },
    },
    eventos: eventosDeSeguranca,
    silencio: contadorDeLimite,
    silencioMs: env.SECURITY_SILENCE_MS,
    retencaoMs: env.SECURITY_EVENT_TTL_MS,
    canal: canalDeAlerta,
    ...(medidorDeSeguranca ? { medidor: medidorDeSeguranca } : {}),
    aoFalhar: ({ erro }) => {
      logger.warn({ err: erro, evento: 'security.detector_falhou' }, 'regra de detecção falhou');
    },
  });

  const auditoria: RegistradorDeAuditoria = criarRegistradorComNotificacao(
    criarRegistradorComDeteccao(registradorDaTrilha, detector),
    notificador,
  );

  const refreshTokenService = criarRefreshTokenService({
    repo: repoRefresh,
    usuarios: repoAuth,
    tokenService,
    auditoria,
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

  // O segundo fator entra no login por porta; sem `MASTER_KEY` a porta não existe e o
  // login volta a ser de um passo — que é o comportamento de antes da SPEC 010.
  const medidorDeMfa = metricas ? criarMedidorDeMfa() : undefined;
  const repoFatores = criarRepositorioDeFatorDeMfa(pool);
  const repoCodigos = criarRepositorioDeCodigosDeRecuperacao(pool);
  const repoDesafios = criarRepositorioDeDesafioDeMfa(banco);
  const portaDeMfa =
    env.MASTER_KEY === undefined
      ? undefined
      : criarServicoDeDesafioDeMfa({
          fatores: repoFatores,
          codigos: repoCodigos,
          desafios: repoDesafios,
          masterKey: env.MASTER_KEY,
          ttlMs: env.MFA_CHALLENGE_TTL_MS,
          maxTentativas: env.MFA_MAX_ATTEMPTS,
          janela: env.MFA_TOTP_WINDOW,
          ...(medidorDeMfa ? { medidor: medidorDeMfa } : {}),
        });

  const politicaDeLimite = criarPoliticaDeRateLimit({
    contador: contadorDeLimite,
    pepper: pepperDeLimite,
    auditoria,
    ...(medidorDeLimite ? { medidor: medidorDeLimite } : {}),
    aoFalhar: ({ rota, dimensao }) => {
      logger.warn(
        { evento: 'rate_limit.contador_indisponivel', rota, dimensao },
        'contador de rate limit indisponível: a requisição seguiu sem o limite',
      );
    },
  });

  /** Barra com o 429 padrão da plataforma — problem+json com `Retry-After`. */
  async function barrarComProblemJson(
    resposta: FastifyReply,
    retryAfterSegundos: number,
  ): Promise<void> {
    await resposta
      .status(429)
      .header('retry-after', String(retryAfterSegundos))
      .type('application/problem+json')
      .send(problemaDeRateLimit());
  }

  /**
   * Barra no formato da RFC 6749. `/oauth/*` tem vocabulário próprio de erro (SPEC 012), e
   * misturar problem+json ali quebraria as bibliotecas cliente de OAuth.
   */
  async function barrarComSlowDown(
    resposta: FastifyReply,
    retryAfterSegundos: number,
  ): Promise<void> {
    await resposta
      .status(429)
      .header('retry-after', String(retryAfterSegundos))
      .type('application/json')
      .send({ error: 'slow_down', error_description: 'Limite de requisições excedido.' });
  }

  const limitePorConta = criarHookDeLimitePorIdentidade({
    politica: politicaDeLimite,
    dimensao: 'conta',
    teto: env.RATE_LIMIT_LOGIN_ACCOUNT_MAX,
    janelaMs: env.RATE_LIMIT_LOGIN_WINDOW_MS,
    identificar: (requisicao) => {
      const corpo = requisicao.body as { email?: unknown } | undefined;
      return typeof corpo?.email === 'string' ? corpo.email : null;
    },
    responder: barrarComProblemJson,
  });

  const limitePorCliente = criarHookDeLimitePorIdentidade({
    politica: politicaDeLimite,
    dimensao: 'cliente',
    teto: env.RATE_LIMIT_OAUTH_CLIENT_MAX,
    janelaMs: env.RATE_LIMIT_LOGIN_WINDOW_MS,
    identificar: (requisicao) =>
      clientIdApresentado(requisicao.headers.authorization, requisicao.body ?? {}),
    responder: barrarComSlowDown,
  });

  const authService = criarAuthService({
    repo: repoAuth,
    servicoDeSenha,
    tokenService,
    refreshToken: refreshTokenService,
    denylist,
    auditoria,
    ...(portaDeMfa ? { mfa: portaDeMfa } : {}),
    ...(metricas ? { medidor: criarMedidorDeAuth() } : {}),
  });

  const passwordService = criarPasswordService({
    servicoDeSenha,
    usuarios: repoUsuarios,
    tokensDeReset: criarRepositorioDeTokenDeReset(banco),
    historico: criarRepositorioDeHistorico(pool),
    sessoes,
    // A porta da 009 finalmente tem concreto: sem NOTIFY_RESET_URL não há para onde
    // apontar o link, e o log-fallback continua sendo o que sobra.
    notificacao:
      env.NOTIFY_RESET_URL === undefined
        ? criarCanalDeLog(logger)
        : criarCanalDeReset({
            notificacoes,
            urlDeReset: env.NOTIFY_RESET_URL,
            validadeMin: TTL_RESET_MIN,
          }),
    ttlResetMin: TTL_RESET_MIN,
    historicoN: 3,
    auditoria,
  });

  const repoPoliticas = criarRepositorioDePolitica(pool);
  const motor = criarMotorDePoliticas({
    politicas: repoPoliticas,
    ...(metricas ? { medidor: criarMedidorDeAbac() } : {}),
  });

  const repoClientes = criarRepositorioDeClientes(pool);
  const clienteService = criarApiClientService({
    repo: repoClientes,
    escopos: criarResolvedorDeEscopos(criarCatalogoDeEscopos(pool)),
    servicoDeSenha,
    logger,
    auditoria,
    sobreposicaoPadraoMs: env.CLIENT_SECRET_OVERLAP_DEFAULT_MS,
    ...(metricas ? { medidor: criarMedidorDeClientes() } : {}),
  });

  const repoPermissoes = criarRepositorioDePermissao(pool);

  const oauthService = criarOAuthService({
    clientAuth: criarClientAuthService({
      repo: repoClientes,
      servicoDeSenha,
      logger,
      throttleDeUsoMs: env.CLIENT_LAST_USED_THROTTLE_MS,
      ...(metricas ? { medidor: criarMedidorDeClientes() } : {}),
    }),
    tokenService,
    authService,
    refreshTokenService,
    auditoria,
    passwordGrantHabilitado: env.OAUTH_PASSWORD_GRANT_ENABLED,
    ...(metricas ? { medidor: criarMedidorDeOAuth() } : {}),
  });

  const metadataService = criarMetadataService({
    emissor: env.JWT_ISSUER,
    urlBase: env.JWT_ISSUER,
    passwordGrantHabilitado: env.OAUTH_PASSWORD_GRANT_ENABLED,
    // Teto alto o bastante para o catálogo inteiro de uma instalação real; o documento é
    // de descoberta, e uma lista truncada em silêncio seria pior que uma consulta cara.
    listarEscopos: async () =>
      (await repoPermissoes.listar({ limite: 500, offset: 0 })).map((p) => p.name),
  });

  const rotacao =
    env.MASTER_KEY === undefined
      ? undefined
      : criarKeyRotationService({
          repo: repoJwks,
          masterKey: env.MASTER_KEY,
          logger,
          auditoria,
          invalidarCache: () => {
            jwks.invalidar();
          },
          graceMs: env.JWKS_GRACE_PERIOD_MS,
          prepublicacaoMinMs: env.JWKS_PREPUBLISH_MIN_MS,
          purgaAposMs: env.JWKS_PURGE_AFTER_MS,
          ...(metricas ? { medidor: criarMedidorDeJwks() } : {}),
        });

  return {
    rateLimit: {
      contador: contadorDeLimite,
      pepper: pepperDeLimite,
      // A dimensão IP é decidida pelo plugin; o registro na trilha entra por aqui para os
      // três excessos aparecerem no mesmo lugar.
      aoExcederPorIp: () => {
        medidorDeLimite?.contarBloqueio('*', 'ip');
        void auditoria.registrar({
          type: 'iam.rate_limit.exceeded',
          actor: { id: null, type: 'system' },
          outcome: 'failure',
          metadata: { dimensao: 'ip' },
        });
      },
    },
    auth: { authService, verificarAccessToken, limitePorConta },
    refresh: { refreshTokenService },
    oauth: { oauthService, limitePorCliente },
    ...(env.MASTER_KEY === undefined
      ? {}
      : {
          mfa: {
            // A cota é do usuário, não do desafio: sem isto, pedir um desafio novo zeraria
            // o contador e o teto por tentativa viraria decoração.
            limitePorConta: criarHookDeLimitePorIdentidade({
              politica: politicaDeLimite,
              dimensao: 'conta',
              teto: env.RATE_LIMIT_MFA_ACCOUNT_MAX,
              janelaMs: env.RATE_LIMIT_LOGIN_WINDOW_MS,
              identificar: async (requisicao) => {
                const corpo = requisicao.body as { mfa_token?: unknown } | undefined;
                if (typeof corpo?.mfa_token !== 'string') return null;
                const desafio = await repoDesafios.buscar(digerirTokenDeDesafio(corpo.mfa_token));
                return desafio?.userId ?? null;
              },
              responder: barrarComProblemJson,
            }),
            mfaService: criarMfaService({
              fatores: repoFatores,
              codigos: repoCodigos,
              desafios: repoDesafios,
              usuarios: repoUsuarios,
              servicoDeSenha,
              masterKey: env.MASTER_KEY,
              emissor: env.MFA_ISSUER ?? new URL(env.JWT_ISSUER).host,
              quantidadeDeCodigos: env.MFA_RECOVERY_CODE_COUNT,
              janela: env.MFA_TOTP_WINDOW,
              sessoes,
              auditoria,
              ...(medidorDeMfa ? { medidor: medidorDeMfa } : {}),
            }),
            authService,
            autenticar: idAutenticado,
            verificarAccessToken,
            guards,
          },
        }),
    metadadosDeOAuth: { metadataService },
    senha: { passwordService, autenticar: idAutenticado },
    users: {
      userService: criarUserService({
        repositorio: repoUsuarios,
        servicoDeSenha,
        sessoes,
        auditoria,
      }),
      autorizador: criarAutorizadorDeAdministracao(),
      ...(metricas ? { medidor: criarMedidorDeUsuarios() } : {}),
    },
    rbac: {
      rbacService: criarRbacService({
        papeis: criarRepositorioDePapel(pool),
        permissoes: repoPermissoes,
        associacoes: repoAssociacoes,
        auditoria,
      }),
      assignmentService: criarAssignmentService({ associacoes: repoAssociacoes, auditoria }),
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
    seguranca: {
      eventos: eventosDeSeguranca,
      guards,
      verificarAccessToken,
    },
    notificacoes: {
      notificacoes,
      destinatarios: env.NOTIFY_OPERATOR_EMAILS,
      transporte: env.NOTIFY_TRANSPORT,
      guards,
      verificarAccessToken,
    },
    auditoria: {
      consulta: criarAuditQueryService(trilha),
      integridade: criarAuditIntegrityService({
        trilha,
        checkpoints,
        janelaMaxima: env.AUDIT_INTEGRITY_MAX_WINDOW,
      }),
      guards,
      verificarAccessToken,
    },
    ...(rotacao === undefined
      ? {}
      : { chaves: { rotacao, repo: repoJwks, guards, verificarAccessToken } }),
  };
}
