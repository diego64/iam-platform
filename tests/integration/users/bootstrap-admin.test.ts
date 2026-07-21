/**
 * Confere o bootstrap do primeiro admin: cria uma vez com env, é idempotente numa segunda
 * subida e é no-op sem env.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { garantirAdminDeBootstrap } from '../../../src/modules/users/services/bootstrap-admin.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from './schema.js';

const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
const logger = criarLogger({ nivel: 'fatal' });
const EMAIL = 'admin@iam.local';
const SENHA = 'S3nh@AdminForte!';

let pool: Pool;

async function contarComEmail(email: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM users WHERE email = $1',
    [email],
  );
  return Number(rows[0]?.n ?? '0');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchema(pool);
});

beforeEach(async () => {
  await limparUsuarios(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('garantirAdminDeBootstrap', () => {
  it('cria o admin quando as envs estão presentes', async () => {
    await garantirAdminDeBootstrap({
      pool,
      servicoDeSenha,
      logger,
      opcoes: { email: EMAIL, senha: SENHA },
    });
    expect(await contarComEmail(EMAIL)).toBe(1);
  });

  it('é idempotente numa segunda subida', async () => {
    const opcoes = { email: EMAIL, senha: SENHA };
    await garantirAdminDeBootstrap({ pool, servicoDeSenha, logger, opcoes });
    await garantirAdminDeBootstrap({ pool, servicoDeSenha, logger, opcoes });
    expect(await contarComEmail(EMAIL)).toBe(1);
  });

  it('não faz nada sem as envs', async () => {
    await garantirAdminDeBootstrap({ pool, servicoDeSenha, logger, opcoes: {} });
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    expect(Number(rows[0]?.n ?? '0')).toBe(0);
  });
});
