/**
 * Garante que o seed da 0005 é idempotente: aplicar duas vezes mantém uma única política
 * `system-ownership` e as três permissões `policies:*`, e que a tabela recusa um `effect`
 * fora de permit|deny (o CHECK é a última barreira caso a borda falhe).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { aplicarPoliticas, recriarSchemaAbac } from '../abac/schema.js';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchemaAbac(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('seed de ABAC (migração 0005)', () => {
  it('semeia a política de posse como is_system', async () => {
    const { rows } = await pool.query<{
      effect: string;
      resource_type: string;
      action: string;
      is_system: boolean;
      condition: unknown;
    }>(
      `SELECT effect, resource_type, action, is_system, condition
         FROM policies WHERE name = 'system-ownership'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect).toBe('permit');
    expect(rows[0]?.resource_type).toBe('*');
    expect(rows[0]?.action).toBe('*');
    expect(rows[0]?.is_system).toBe(true);
    expect(rows[0]?.condition).toEqual({
      op: 'eq',
      attr: 'resource.owner_id',
      value: { ref: 'subject.sub' },
    });
  });

  it('semeia as três permissões policies:* vinculadas ao superadmin', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT p.name FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'policies:%'
        ORDER BY p.name`,
    );
    expect(rows.map((l) => l.name)).toEqual(['policies:delete', 'policies:read', 'policies:write']);
  });

  it('reaplicar o seed não duplica política, permissão nem vínculo', async () => {
    await aplicarPoliticas(pool);
    await aplicarPoliticas(pool);

    const politica = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM policies WHERE name = 'system-ownership'",
    );
    const permissoes = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE name LIKE 'policies:%'",
    );
    const vinculos = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'policies:%'`,
    );
    expect(politica.rows[0]?.n).toBe(1);
    expect(permissoes.rows[0]?.n).toBe(3);
    expect(vinculos.rows[0]?.n).toBe(3);
  });

  it('recusa effect fora de permit|deny (CHECK da tabela)', async () => {
    await expect(
      pool.query(
        `INSERT INTO policies (name, effect, resource_type, action, condition)
         VALUES ('efeito-invalido', 'maybe', 'user', 'read', '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
  });
});
