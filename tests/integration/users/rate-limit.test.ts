/**
 * Confere que a rota de criação responde 429 com Retry-After ao estourar o teto por IP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { montarAppDeUsuario } from './helper-app.js';
import { LIMITE_CRIACAO } from '../../../src/modules/users/hooks/users-rate-limit.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from './schema.js';

const ADMIN = { 'x-test-admin': 'admin-1' };
const SENHA = 'S3nh@MuitoForte!';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchema(pool);
  await limparUsuarios(pool);
  ({ app } = await montarAppDeUsuario({ pool }));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('rate limit de POST /users', () => {
  it('estourado o teto, responde 429 com Retry-After', async () => {
    let ultima = 0;
    let corpo429 = '';
    // Uma além do teto: as primeiras passam pelo handler (mesmo e-mail ⇒ 409), a que
    // excede é barrada pelo plugin antes de tocar o handler.
    for (let i = 0; i <= LIMITE_CRIACAO.max; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/users',
        headers: ADMIN,
        payload: { email: 'flood@iam.local', senha: SENHA },
      });
      ultima = r.statusCode;
      corpo429 = r.headers['retry-after']?.toString() ?? corpo429;
    }
    expect(ultima).toBe(429);
    expect(corpo429).not.toBe('');
  });
});
