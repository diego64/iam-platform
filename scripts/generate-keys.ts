/**
 * Responsabilidade: bootstrap do primeiro par Ed25519 — gera, cifra a privada (envelope
 * AES-256-GCM) e insere na tabela `jwks` com status active.
 * Regras:
 *  - Idempotente: se já existe chave active, não cria uma segunda (o índice único parcial
 *    também barraria, mas a checagem evita o erro e deixa o script repetível).
 *  - Jamais imprime a privada — só o `kid`. `MASTER_KEY` ausente aborta antes de gerar.
 *  - Lê a configuração via carregarEnv (nunca process.env direto).
 */
import { carregarEnv } from '../src/config/env.js';
import { criarLogger } from '../src/shared/logger/index.js';
import { criarPoolPostgres } from '../src/database/postgres/connection.js';
import { criarRepositorioJwks, garantirChaveDeBootstrap } from '../src/modules/jwks/index.js';

async function main(): Promise<void> {
  const logger = criarLogger();
  const env = carregarEnv();

  if (env.MASTER_KEY === undefined) {
    logger.fatal('generate-keys: MASTER_KEY ausente — impossível cifrar a chave privada');
    process.exit(1);
  }

  const pool = criarPoolPostgres(env);

  try {
    await garantirChaveDeBootstrap({
      repo: criarRepositorioJwks(pool),
      masterKey: env.MASTER_KEY,
      logger,
    });
  } finally {
    await pool.end();
  }
}

void main();
