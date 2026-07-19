/**
 * Responsabilidade: criar o Pool do pg a partir de env; expor tipo para injeção nos repositórios.
 * Regras: repositórios recebem Pool/PoolClient por construtor — proibido importar este módulo dentro de modules/.
 */
import pg from 'pg';
import { env } from '../../config/env.js';

export function criarPoolPostgres(): pg.Pool {
  return new pg.Pool({
    connectionString: env.POSTGRES_URL,
    max: env.POSTGRES_POOL_MAX,
  });
}
