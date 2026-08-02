/**
 * Recria o schema real da tabela `jwks` nos testes de integração aplicando a DDL das
 * migrações que vão a produção, em vez de um `CREATE TABLE` inline.
 *
 * A 0006 (rotação) acrescenta `verifiable_until`, o índice de chave `next` única e semeia as
 * permissões `keys:*` vinculadas ao superadmin — por isso as tabelas de RBAC da 0001 e os
 * metadados da 0004 precisam existir antes. Ambas são `IF NOT EXISTS`/`ON CONFLICT`, então
 * aplicá-las aqui não destrói o que outra suíte tenha semeado.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

function ddl(arquivo: string): string {
  return readFileSync(
    new URL(`../../../src/database/migrations/${arquivo}`, import.meta.url),
    'utf8',
  );
}

const DDL_RBAC = ddl('0001_create_users_rbac.sql');
const DDL_JWKS = ddl('0002_create_jwks.sql');
const DDL_METADATA = ddl('0004_rbac_metadata_seed.sql');
const DDL_ROTACAO = ddl('0006_key_rotation.sql');

/** Aplica só a 0006 — usado pelo teste de idempotência (rodar duas vezes). */
export async function aplicarRotacao(pool: Pool): Promise<void> {
  await pool.query(DDL_ROTACAO);
}

export async function recriarSchemaJwks(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS jwks CASCADE');
  await pool.query(DDL_RBAC);
  await pool.query(DDL_METADATA);
  await pool.query(DDL_JWKS);
  await pool.query(DDL_ROTACAO);
}

export async function limparJwks(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE jwks');
}
