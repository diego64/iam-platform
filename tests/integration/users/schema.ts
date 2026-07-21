/**
 * Recria o schema real da 002/003 nos testes de integração aplicando a DDL das migrações
 * `0001` (users + RBAC) e `0003` (password_history), em vez de um `CREATE TABLE` inline.
 * Assim o teste exercita a mesma DDL que vai a produção — inclusive a extensão `citext` e
 * as FKs `ON DELETE CASCADE` que o hard delete da 002 depende.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

const DDL_RBAC = readFileSync(
  new URL('../../../src/database/migrations/0001_create_users_rbac.sql', import.meta.url),
  'utf8',
);
const DDL_HISTORY = readFileSync(
  new URL('../../../src/database/migrations/0003_create_password_history.sql', import.meta.url),
  'utf8',
);

export async function recriarSchema(pool: Pool): Promise<void> {
  await pool.query(
    'DROP TABLE IF EXISTS password_history, role_permissions, user_roles, permissions, roles, users CASCADE',
  );
  await pool.query(DDL_RBAC);
  await pool.query(DDL_HISTORY);
}

export async function limparUsuarios(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE users CASCADE');
}
