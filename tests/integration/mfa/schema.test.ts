/**
 * A DDL de MFA contra um Postgres real: idempotência do migrate, os índices parciais que
 * limitam o fator a um ativo e um pendente por usuário, o CHECK de coerência entre status e
 * confirmação, e o seed da permissão de reset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { aplicarMfa, limparMfa, recriarSchemaDeMfa } from './schema.js';

let pool: Pool;
let userId: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaDeMfa(pool);

  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    ['mfa-schema@iam.local', 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
  );
  userId = rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.end();
});

async function inserirFator(campos: {
  status: 'pending' | 'active';
  confirmado: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_mfa_factors (user_id, secret_encrypted, status, confirmed_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, Buffer.from('blob'), campos.status, campos.confirmado ? new Date() : null],
  );
}

describe('migração 0009', () => {
  it('é idempotente: reaplicar não falha', async () => {
    await expect(aplicarMfa(pool)).resolves.not.toThrow();
    await expect(aplicarMfa(pool)).resolves.not.toThrow();
  });

  it('semeia mfa:reset vinculada ao superadmin', async () => {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name = 'mfa:reset'`,
    );
    expect(rows[0]?.total).toBe('1');
  });
});

describe('índices parciais do fator', () => {
  it('recusa dois fatores ativos para o mesmo usuário', async () => {
    await limparMfa(pool);
    await inserirFator({ status: 'active', confirmado: true });

    await expect(inserirFator({ status: 'active', confirmado: true })).rejects.toThrow();
  });

  it('recusa dois cadastros pendentes para o mesmo usuário', async () => {
    await limparMfa(pool);
    await inserirFator({ status: 'pending', confirmado: false });

    await expect(inserirFator({ status: 'pending', confirmado: false })).rejects.toThrow();
  });

  it('permite um ativo e um pendente ao mesmo tempo', async () => {
    // É o cadastro reiniciado: o fator novo ainda não protege nada, e o ativo continua
    // valendo até a confirmação.
    await limparMfa(pool);
    await inserirFator({ status: 'active', confirmado: true });

    await expect(inserirFator({ status: 'pending', confirmado: false })).resolves.not.toThrow();
  });
});

describe('coerência entre status e confirmação', () => {
  it('recusa ativo sem confirmed_at', async () => {
    await limparMfa(pool);

    await expect(inserirFator({ status: 'active', confirmado: false })).rejects.toThrow();
  });

  it('recusa pendente com confirmed_at', async () => {
    await limparMfa(pool);

    await expect(inserirFator({ status: 'pending', confirmado: true })).rejects.toThrow();
  });
});

describe('códigos de recuperação', () => {
  it('o hash é único em toda a tabela', async () => {
    await limparMfa(pool);
    const inserir = (): Promise<unknown> =>
      pool.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
        userId,
        'hash-repetido',
      ]);

    await inserir();

    await expect(inserir()).rejects.toThrow();
  });

  it('remover o usuário leva fator e códigos junto', async () => {
    await limparMfa(pool);
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['mfa-cascata@iam.local', 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
    );
    const alvo = rows[0]?.id ?? '';
    await pool.query('INSERT INTO user_mfa_factors (user_id, secret_encrypted) VALUES ($1, $2)', [
      alvo,
      Buffer.from('blob'),
    ]);
    await pool.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
      alvo,
      'hash-da-cascata',
    ]);

    await pool.query('DELETE FROM users WHERE id = $1', [alvo]);

    const fatores = await pool.query('SELECT 1 FROM user_mfa_factors WHERE user_id = $1', [alvo]);
    const codigos = await pool.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1', [alvo]);
    expect(fatores.rowCount).toBe(0);
    expect(codigos.rowCount).toBe(0);
  });
});
