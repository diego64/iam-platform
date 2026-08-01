/**
 * Cobre o rate limit das rotas de sessão: o teto é por conta (o `sub` do token). Uma rajada
 * do mesmo token além do teto no minuto responde 429 com Retry-After.
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
import { montarAppDeAuth } from '../auth/helper-app.js';

const EMAIL = 'sess-limite@iam.local';
const SENHA = 'S3nh@Forte!';

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
  await banco.collection('active_sessions').deleteMany({});

  let servicoDeSenha;
  ({ app, servicoDeSenha } = await montarAppDeAuth({ pool, banco }));
  const hash = await servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [EMAIL, hash]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('rate limit por conta em /auth/sessions', () => {
  it('estoura 429 com Retry-After após o teto de 60/min', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.5.0.1',
      payload: { email: EMAIL, senha: SENHA },
    });
    const accessToken = login.json<{ access_token: string }>().access_token;

    let excedeu = false;
    for (let i = 0; i < 61; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/sessions',
        // IP variável de propósito: o balde é a conta, não o IP.
        remoteAddress: `10.5.9.${String(i)}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (res.statusCode === 429) {
        excedeu = true;
        expect(res.headers['retry-after']).toBeDefined();
        break;
      }
    }
    expect(excedeu).toBe(true);
  });
});
