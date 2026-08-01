/**
 * Cobre o rate limit de /auth/login: estourado o teto por janela (mesmo IP), a rota responde
 * 429 com Retry-After, sem chegar a processar a credencial.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { montarAppDeAuth } from './helper-app.js';
import { LIMITE_LOGIN } from '../../../src/modules/auth/hooks/login-rate-limit.js';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  ({ app } = await montarAppDeAuth({ pool, banco }));
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('rate limit de /auth/login', () => {
  it('bloqueia com 429 e Retry-After ao passar do teto da janela', async () => {
    const respostas = [];
    // Uma requisição a mais que o teto, todas do mesmo IP.
    for (let n = 0; n <= LIMITE_LOGIN.max; n += 1) {
      respostas.push(
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          remoteAddress: '203.0.113.7',
          payload: { email: 'x@iam.local', senha: 'Qualquer123!' },
        }),
      );
    }

    const excedente = respostas[respostas.length - 1];
    expect(excedente?.statusCode).toBe(429);
    expect(excedente?.headers['retry-after']).toBeDefined();
  });
});
