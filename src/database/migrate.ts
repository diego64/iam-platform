/**
 * Responsabilidade: aplicar as migrations SQL de ./migrations em ordem lexicográfica,
 * registrando cada uma em schema_migrations; suportar --dry-run (lista pendentes sem aplicar).
 * Regras: uma transação por migration; idempotente (já-aplicada é pulada); saída clara por
 *         arquivo aplicado/pulado. Roda tanto via `tsx` (dev/CI, lê src/) quanto compilado
 *         em `dist/` (produção) — os .sql são resolvidos relativos a este arquivo.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { carregarEnv } from '../config/env.js';
import { criarLogger } from '../shared/logger/index.js';
import { criarPoolPostgres } from './postgres/connection.js';

const PASTA_DE_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Lista os arquivos .sql em ordem lexicográfica — o prefixo numérico (0001_) define a ordem. */
function listarMigrations(): string[] {
  return readdirSync(PASTA_DE_MIGRATIONS)
    .filter((nome) => nome.endsWith('.sql'))
    .sort();
}

async function migrar(dryRun: boolean): Promise<void> {
  const env = carregarEnv();
  const logger = criarLogger({ nivel: env.LOG_LEVEL });
  const pool = criarPoolPostgres(env);

  try {
    // Tabela de controle: sem ela não há como saber o que já rodou. IF NOT EXISTS fora de
    // transação para não brigar com o CREATE das próprias migrations.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    const jaAplicadas = new Set(rows.map((r) => r.version));

    for (const arquivo of listarMigrations()) {
      if (jaAplicadas.has(arquivo)) {
        logger.info({ migration: arquivo }, 'pulada (já aplicada)');
        continue;
      }
      if (dryRun) {
        logger.info({ migration: arquivo }, 'pendente (dry-run: não aplicada)');
        continue;
      }

      const sql = readFileSync(join(PASTA_DE_MIGRATIONS, arquivo), 'utf8');
      const cliente = await pool.connect();
      try {
        // Transação por migration: um erro no meio não deixa a tabela meio-criada nem
        // registra a versão como aplicada.
        await cliente.query('BEGIN');
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migrations (version) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
        logger.info({ migration: arquivo }, 'aplicada');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    }
  } finally {
    await pool.end();
  }
}

// Falha-fecha: erro na migração ⇒ exit 1, para o preDeployCommand barrar a troca de tráfego.
migrar(process.argv.includes('--dry-run')).catch((erro: unknown) => {
  criarLogger().fatal({ err: erro }, 'falha ao aplicar migrations');
  process.exit(1);
});
