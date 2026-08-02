/**
 * Garante que o seed da 0004 é idempotente: aplicar duas vezes não duplica o papel
 * superadmin nem a permissão curinga, e o vínculo entre eles continua único.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaRbac, aplicarMetadadosRbac } from './schema.js';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchemaRbac(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('seed de RBAC (migração 0004)', () => {
  it('semeia superadmin com a permissão curinga', async () => {
    const { rows } = await pool.query<{ name: string; is_system: boolean }>(
      "SELECT name, is_system FROM roles WHERE name = 'superadmin'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_system).toBe(true);

    const perms = await pool.query<{ name: string }>(
      `SELECT p.name FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin'`,
    );
    expect(perms.rows.map((l) => l.name)).toEqual(['*']);
  });

  it('reaplicar o seed não duplica papel, permissão nem vínculo', async () => {
    await aplicarMetadadosRbac(pool);
    await aplicarMetadadosRbac(pool);

    const papeis = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roles WHERE name = 'superadmin'",
    );
    const curinga = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE name = '*'",
    );
    const vinculo = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name = '*'`,
    );
    expect(papeis.rows[0]?.n).toBe(1);
    expect(curinga.rows[0]?.n).toBe(1);
    expect(vinculo.rows[0]?.n).toBe(1);
  });

  it('marca as permissões-base como is_system', async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE is_system = true AND name LIKE 'roles:%'",
    );
    expect(rows[0]?.n).toBe(3);
  });
});
