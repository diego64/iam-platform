/**
 * Cobre a migração 0006: a coluna `verifiable_until`, o índice único parcial que impede uma
 * segunda chave `next`, o backfill das chaves já aposentadas e o seed idempotente das
 * permissões `keys:*`. Reaplicar a migração inteira não pode falhar nem duplicar nada — o
 * migrate roda contra bancos em estados diferentes e reaplicação é o caso normal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { gerarParEd25519 } from '../../../src/modules/jwks/services/key-factory.js';
import { cifrarPrivada } from '../../../src/shared/crypto/key-envelope.js';
import type { StatusDaChave } from '../../../src/modules/jwks/types/jwks.types.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { aplicarRotacao, limparJwks, recriarSchemaJwks } from '../jwks/schema.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

let pool: Pool;

/** Insere uma chave direto no banco, contornando o repositório (que ainda não conhece a coluna). */
async function inserirChave(
  status: StatusDaChave,
  extras: { retiredAt?: Date; verifiableUntil?: Date } = {},
): Promise<string> {
  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  await pool.query(
    `INSERT INTO jwks (kid, algorithm, public_jwk, private_key_enc, status, retired_at, verifiable_until)
     VALUES ($1, 'EdDSA', $2, $3, $4, $5, $6)`,
    [
      kid,
      JSON.stringify(publicJwk),
      cifrarPrivada(privateKeyDer, MASTER),
      status,
      extras.retiredAt ?? null,
      extras.verifiableUntil ?? null,
    ],
  );
  return kid;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchemaJwks(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('migração 0006 — rotação de chaves', () => {
  it('acrescenta verifiable_until como TIMESTAMPTZ anulável', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'jwks' AND column_name = 'verifiable_until'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe('timestamp with time zone');
    expect(rows[0]?.is_nullable).toBe('YES');
  });

  it('impede uma segunda chave next (índice único parcial jwks_one_next)', async () => {
    await limparJwks(pool);
    await inserirChave('next');
    await expect(inserirChave('next')).rejects.toThrow();
  });

  it('permite várias chaves retired — o índice parcial só trava next', async () => {
    await limparJwks(pool);
    await inserirChave('retired', { retiredAt: new Date(), verifiableUntil: new Date() });
    await expect(
      inserirChave('retired', { retiredAt: new Date(), verifiableUntil: new Date() }),
    ).resolves.toBeTypeOf('string');
  });

  it('cria o índice de consulta do conjunto de verificação', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'jwks' AND indexname IN ('jwks_one_next', 'idx_jwks_verifiable')
        ORDER BY indexname`,
    );
    expect(rows.map((l) => l.indexname)).toEqual(['idx_jwks_verifiable', 'jwks_one_next']);
  });

  it('faz o backfill das retired que já existiam sem verifiable_until', async () => {
    await limparJwks(pool);
    const aposentadaEm = new Date('2026-01-01T10:00:00.000Z');
    const kid = await inserirChave('retired', { retiredAt: aposentadaEm });

    await aplicarRotacao(pool);

    const { rows } = await pool.query<{ verifiable_until: Date | null }>(
      'SELECT verifiable_until FROM jwks WHERE kid = $1',
      [kid],
    );
    // A janela de graça padrão é o TTL do access token: 15 minutos após a aposentadoria.
    expect(rows[0]?.verifiable_until?.toISOString()).toBe('2026-01-01T10:15:00.000Z');
  });

  it('não sobrescreve verifiable_until já preenchido ao reaplicar', async () => {
    await limparJwks(pool);
    const definido = new Date('2026-02-02T08:00:00.000Z');
    const kid = await inserirChave('retired', {
      retiredAt: new Date('2026-02-02T07:00:00.000Z'),
      verifiableUntil: definido,
    });

    await aplicarRotacao(pool);

    const { rows } = await pool.query<{ verifiable_until: Date | null }>(
      'SELECT verifiable_until FROM jwks WHERE kid = $1',
      [kid],
    );
    expect(rows[0]?.verifiable_until?.toISOString()).toBe(definido.toISOString());
  });

  it('semeia keys:read e keys:write vinculadas ao superadmin', async () => {
    const { rows } = await pool.query<{ name: string; is_system: boolean }>(
      `SELECT p.name, p.is_system FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'keys:%'
        ORDER BY p.name`,
    );
    expect(rows.map((l) => l.name)).toEqual(['keys:read', 'keys:write']);
    expect(rows.every((l) => l.is_system)).toBe(true);
  });

  it('não semeia uma permissão de revogação — revogar é do papel superadmin', async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE name = 'keys:revoke'",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('reaplicar a migração não falha nem duplica permissão ou vínculo', async () => {
    await aplicarRotacao(pool);
    await aplicarRotacao(pool);

    const permissoes = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE name LIKE 'keys:%'",
    );
    const vinculos = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'keys:%'`,
    );
    expect(permissoes.rows[0]?.n).toBe(2);
    expect(vinculos.rows[0]?.n).toBe(2);
  });
});
