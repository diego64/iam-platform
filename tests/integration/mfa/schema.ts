/**
 * Recria o schema de MFA nos testes de integração aplicando a DDL real das migrações `0001`
 * (users + RBAC), `0004` (metadados/seed do RBAC) e `0009` (MFA), em vez de um `CREATE
 * TABLE` inline.
 *
 * A 0009 semeia uma permissão vinculada ao papel `superadmin` da 0004, então a ordem importa.
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
const DDL_MFA = ddl('0009_mfa.sql');

/** Aplica só a 0009 — usado pelo teste de idempotência (rodar duas vezes). */
export async function aplicarMfa(pool: Pool): Promise<void> {
  await pool.query(DDL_MFA);
}

export async function recriarSchemaDeMfa(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS mfa_recovery_codes, user_mfa_factors CASCADE');
  await pool.query(
    'DROP TABLE IF EXISTS role_permissions, user_roles, permissions, roles, users CASCADE',
  );
  await pool.query(DDL_RBAC);
  await pool.query(DDL_METADATA);
  await pool.query(DDL_MFA);
}

export async function limparMfa(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE mfa_recovery_codes, user_mfa_factors CASCADE');
}
