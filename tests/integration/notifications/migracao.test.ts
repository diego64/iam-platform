/**
 * Cobre a migração desta SPEC contra um PostgreSQL real.
 *
 * Ela não cria tabela — cria autoridade. O que precisa ser verdade é que a permissão nasce
 * ligada ao superadmin e que reaplicar a migração não quebra o `migrate`, que roda no start
 * de todo deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaRbac } from '../rbac/schema.js';

const DDL_NOTIFICACOES = readFileSync(
  new URL('../../../src/database/migrations/0011_notifications.sql', import.meta.url),
  'utf8',
);

let pool: Pool;

async function contar(consulta: string, valores: readonly unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(consulta, [...valores]);
  return Number(rows[0]?.n ?? '0');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchemaRbac(pool);
  await pool.query(DDL_NOTIFICACOES);
});

afterAll(async () => {
  await pool.end();
});

describe('0011_notifications', () => {
  it('semeia a permissão como permissão de sistema', async () => {
    const { rows } = await pool.query<{ name: string; is_system: boolean }>(
      'SELECT name, is_system FROM permissions WHERE name = $1',
      ['notifications:send'],
    );

    expect(rows[0]?.name).toBe('notifications:send');
    // `is_system` é o que impede a permissão de ser apagada pela API de RBAC.
    expect(rows[0]?.is_system).toBe(true);
  });

  it('liga a permissão ao superadmin', async () => {
    const vinculos = await contar(
      `SELECT count(*)::text AS n
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name = 'notifications:send'`,
    );

    expect(vinculos).toBe(1);
  });

  it('é idempotente — o migrate roda no start de todo deploy', async () => {
    await pool.query(DDL_NOTIFICACOES);
    await pool.query(DDL_NOTIFICACOES);

    expect(
      await contar("SELECT count(*)::text AS n FROM permissions WHERE name = 'notifications:send'"),
    ).toBe(1);
  });

  it('não cria tabela nenhuma', async () => {
    // Nada desta SPEC persiste no PostgreSQL; se um dia criar, a decisão precisa ser
    // deliberada e não um efeito colateral de outra migração.
    const tabelas = await contar(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'notification%'`,
    );

    expect(tabelas).toBe(0);
  });
});
