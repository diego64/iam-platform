/**
 * Responsabilidade: criar o Pool do pg a partir da configuração e provar a conexão no boot.
 * Regras: recebe `env` por parâmetro — nunca importa singleton de configuração (ADR-0001).
 *         Repositórios recebem Pool/PoolClient por construtor — proibido importar este
 *         módulo dentro de modules/.
 */
import pg from 'pg';
import type { Env } from '../../config/env.js';

/** Teto para a conexão inicial: sem isso o boot pende indefinidamente num host errado. */
export const TIMEOUT_DE_CONEXAO_MS = 5_000;

export function criarPoolPostgres(env: Env): pg.Pool {
  return new pg.Pool({
    connectionString: env.POSTGRES_URL,
    max: env.POSTGRES_POOL_MAX,
    connectionTimeoutMillis: TIMEOUT_DE_CONEXAO_MS,
  });
}

/**
 * Verifica que o pool realmente fala com o banco. Chamado no bootstrap para transformar
 * "host inalcançável" em falha imediata, em vez de erro na primeira query de produção.
 * @throws propaga o erro do driver — o server.ts converte em log fatal + exit 1.
 */
export async function verificarPostgres(pool: pg.Pool): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT 1');
  } finally {
    cliente.release();
  }
}
