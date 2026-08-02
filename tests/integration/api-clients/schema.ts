/**
 * Recria o schema de clientes de API nos testes de integração aplicando a DDL real das
 * migrações `0001` (users + RBAC), `0004` (metadados/seed do RBAC) e `0007` (clientes), em
 * vez de um `CREATE TABLE` inline.
 *
 * A 0007 semeia permissões vinculadas ao papel `superadmin` da 0004 e referencia
 * `permissions` pela FK dos escopos, então a ordem importa.
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
const DDL_CLIENTES = ddl('0007_api_clients.sql');

/** Aplica só a 0007 — usado pelo teste de idempotência (rodar duas vezes). */
export async function aplicarClientes(pool: Pool): Promise<void> {
  await pool.query(DDL_CLIENTES);
}

export async function recriarSchemaDeClientes(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS api_client_scopes, api_clients CASCADE');
  await pool.query(
    'DROP TABLE IF EXISTS role_permissions, user_roles, permissions, roles, users CASCADE',
  );
  await pool.query(DDL_RBAC);
  await pool.query(DDL_METADATA);
  await pool.query(DDL_CLIENTES);
}

export async function limparClientes(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE api_client_scopes, api_clients CASCADE');
}
