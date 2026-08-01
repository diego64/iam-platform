/**
 * Recria o schema de RBAC nos testes de integração aplicando a DDL real das migrações
 * `0001` (users + RBAC) e `0004` (metadados + seed), em vez de um `CREATE TABLE` inline.
 * Assim o teste exercita a mesma DDL que vai a produção — inclusive o seed do superadmin
 * e as colunas `is_system` de que o guard e as regras de imutabilidade dependem.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

const DDL_RBAC = readFileSync(
  new URL('../../../src/database/migrations/0001_create_users_rbac.sql', import.meta.url),
  'utf8',
);
const DDL_METADATA = readFileSync(
  new URL('../../../src/database/migrations/0004_rbac_metadata_seed.sql', import.meta.url),
  'utf8',
);

/** Aplica só o seed/metadados — usado pelo teste de idempotência (rodar duas vezes). */
export async function aplicarMetadadosRbac(pool: Pool): Promise<void> {
  await pool.query(DDL_METADATA);
}

export async function recriarSchemaRbac(pool: Pool): Promise<void> {
  await pool.query(
    'DROP TABLE IF EXISTS role_permissions, user_roles, permissions, roles, users CASCADE',
  );
  await pool.query(DDL_RBAC);
  await pool.query(DDL_METADATA);
}
