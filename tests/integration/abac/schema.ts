/**
 * Recria o schema de ABAC nos testes de integração aplicando a DDL real das migrações
 * `0001` (users + RBAC), `0004` (metadados/seed do RBAC) e `0005` (políticas), em vez de um
 * `CREATE TABLE` inline. A 0005 semeia permissões e vínculos que dependem do papel
 * `superadmin` da 0004, então a ordem importa.
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
const DDL_METADATA = ddl('0004_rbac_metadata_seed.sql');
const DDL_POLICIES = ddl('0005_abac_policies.sql');

/** Aplica só a 0005 — usado pelo teste de idempotência (rodar duas vezes). */
export async function aplicarPoliticas(pool: Pool): Promise<void> {
  await pool.query(DDL_POLICIES);
}

export async function recriarSchemaAbac(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS policies CASCADE');
  await pool.query(
    'DROP TABLE IF EXISTS role_permissions, user_roles, permissions, roles, users CASCADE',
  );
  await pool.query(DDL_RBAC);
  await pool.query(DDL_METADATA);
  await pool.query(DDL_POLICIES);
}
