/**
 * Responsabilidade: bootstrap do processo — validar configuração, conectar nos bancos,
 * garantir índices, subir o servidor e registrar o encerramento gracioso.
 * Regras: nada sobe pela metade. Qualquer falha desta sequência é fatal (exit 1), porque
 *         um container que sobe com dependência quebrada passa no health check do
 *         orquestrador e passa a receber tráfego.
 */
// PRIMEIRO import, antes de qualquer módulo da aplicação — e o teste de contrato
// `tests/contract/ordem-telemetria.test.ts` existe só para manter assim. A instrumentação
// automática funciona substituindo métodos de fastify, pg e mongodb; se algum deles for
// carregado antes do sdk.start(), a substituição não acontece. Não há erro, não há aviso:
// a telemetria simplesmente fica vazia, e isso só é descoberto durante uma investigação
// em que o trace já era necessário.
import { telemetria } from './telemetry/index.js';
import { carregarEnv, ErroDeConfiguracao, reportarErroDeConfiguracao } from './config/env.js';
import { criarLogger } from './shared/logger/index.js';
import { criarPoolPostgres, verificarPostgres } from './database/postgres/connection.js';
import { conectarMongo } from './database/mongodb/connection.js';
import { garantirIndices } from './database/mongodb/indexes.js';
import { criarServicoDeSenhaDaEnv } from './shared/crypto/password.service.js';
import { garantirAdminDeBootstrap } from './modules/users/index.js';
import { criarEncerrador } from './bootstrap/shutdown.js';
import { construirApp } from './app.js';
import { obterInstrumentos } from './telemetry/metricas.js';
import { criarServicoDeProntidao } from './modules/health/services/prontidao.service.js';
import {
  criarVerificadorMongo,
  criarVerificadorPostgres,
} from './modules/health/services/verificadores.js';

async function iniciar(): Promise<void> {
  // Logger de boot: antes da validação não existe LOG_LEVEL confiável.
  const loggerDeBoot = criarLogger();

  let env;
  try {
    env = carregarEnv();
  } catch (erro) {
    if (erro instanceof ErroDeConfiguracao) {
      reportarErroDeConfiguracao(erro, loggerDeBoot);
      process.exit(1);
    }
    throw erro;
  }
  loggerDeBoot.info('boot.env_ok');

  const logger = criarLogger({ nivel: env.LOG_LEVEL });
  const pool = criarPoolPostgres(env);

  try {
    await verificarPostgres(pool);
    logger.info('boot.postgres_ok');
  } catch (erro) {
    logger.fatal({ err: erro }, 'boot.postgres_falhou');
    process.exit(1);
  }

  let mongo;
  let banco;
  try {
    ({ cliente: mongo, banco } = await conectarMongo(env));
    logger.info('boot.mongo_ok');
  } catch (erro) {
    logger.fatal({ err: erro }, 'boot.mongo_falhou');
    await pool.end();
    process.exit(1);
  }

  await garantirIndices(banco);
  logger.info('boot.indices_ok');

  // Admin de bootstrap: cria o primeiro admin se as envs estiverem definidas (idempotente).
  // Sem elas, é no-op. Roda depois dos bancos prontos e antes de aceitar tráfego.
  await garantirAdminDeBootstrap({
    pool,
    servicoDeSenha: criarServicoDeSenhaDaEnv(env),
    opcoes: {
      ...(env.IAM_BOOTSTRAP_ADMIN_EMAIL === undefined
        ? {}
        : { email: env.IAM_BOOTSTRAP_ADMIN_EMAIL }),
      ...(env.IAM_BOOTSTRAP_ADMIN_PASSWORD === undefined
        ? {}
        : { senha: env.IAM_BOOTSTRAP_ADMIN_PASSWORD }),
    },
    logger,
  });

  // O controller de health não conhece pg nem mongodb: recebe verificadores prontos.
  const prontidao = criarServicoDeProntidao({
    ...(telemetria.metricas ? { coletor: obterInstrumentos(env.GIT_COMMIT) } : {}),
    verificadores: [
      criarVerificadorPostgres(pool, env.HEALTH_TIMEOUT_MS),
      criarVerificadorMongo(banco, env.HEALTH_TIMEOUT_MS),
    ],
    cacheMs: env.HEALTH_CACHE_MS,
    logger,
  });

  const app = await construirApp(env, { prontidao, telemetria });

  // Handlers ANTES do listen. Registrá-los depois deixa uma janela em que o processo
  // já aceita conexões mas ainda usa o comportamento default de SIGTERM: morte
  // imediata, sem drenar nada. A janela é curta, mas é exatamente quando o
  // orquestrador pode mandar o sinal — no fim de um deploy que está sendo revertido.
  const encerrar = criarEncerrador({
    app,
    pool,
    mongo,
    telemetria,
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    // Marca a indisponibilidade ANTES de app.close(), para o balanceador tirar esta
    // instância da rotação enquanto ela ainda drena as requisições em voo.
    aoIniciarEncerramento: () => {
      prontidao.marcarEncerrando();
    },
    encerrarProcesso: (codigo) => {
      process.exit(codigo);
    },
  });

  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ porta: env.PORT, ambiente: env.NODE_ENV }, 'boot.listening');
}

void iniciar();
