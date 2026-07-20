/**
 * Responsabilidade: bootstrap do processo — validar configuração, conectar nos bancos,
 * garantir índices, subir o servidor e registrar o encerramento gracioso.
 * Regras: nada sobe pela metade. Qualquer falha desta sequência é fatal (exit 1), porque
 *         um container que sobe com dependência quebrada passa no health check do
 *         orquestrador e passa a receber tráfego.
 */
import { carregarEnv, ErroDeConfiguracao, reportarErroDeConfiguracao } from './config/env.js';
import { criarLogger } from './shared/logger/index.js';
import { criarPoolPostgres, verificarPostgres } from './database/postgres/connection.js';
import { conectarMongo } from './database/mongodb/connection.js';
import { garantirIndices } from './database/mongodb/indexes.js';
import { criarEncerrador } from './bootstrap/shutdown.js';
import { construirApp } from './app.js';

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

  const app = await construirApp(env);

  // Handlers ANTES do listen. Registrá-los depois deixa uma janela em que o processo
  // já aceita conexões mas ainda usa o comportamento default de SIGTERM: morte
  // imediata, sem drenar nada. A janela é curta, mas é exatamente quando o
  // orquestrador pode mandar o sinal — no fim de um deploy que está sendo revertido.
  const encerrar = criarEncerrador({
    app,
    pool,
    mongo,
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
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
