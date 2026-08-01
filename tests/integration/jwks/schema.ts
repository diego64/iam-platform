/**
 * Recria o schema real da tabela `jwks` (com o índice único parcial que garante uma única
 * chave active) nos testes de integração, aplicando a mesma DDL de migração que vai a
 * produção em vez de um CREATE TABLE inline.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

const DDL_JWKS = readFileSync(
  new URL('../../../src/database/migrations/0002_create_jwks.sql', import.meta.url),
  'utf8',
);

export async function recriarSchemaJwks(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS jwks CASCADE');
  await pool.query(DDL_JWKS);
}

export async function limparJwks(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE jwks');
}
