/**
 * Cobre o reflexo do reuso na sessão: quando a detecção de reuso derruba uma família, a
 * sessão correspondente some da listagem — o metadado acompanha o que aconteceu com os tokens.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { montarAppDeAuth } from '../auth/helper-app.js';

const EMAIL = 'sess-reuso@iam.local';
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
  await banco.collection('refresh_tokens').deleteMany({});
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

describe('reflexo do reuso na sessão', () => {
  it('reuso detectado remove a sessão da listagem', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.4.0.1',
      payload: { email: EMAIL, senha: SENHA },
    });
    const { access_token: accessToken, refresh_token: refreshA } = login.json<{
      access_token: string;
      refresh_token: string;
    }>();
    const sessionId = decodeJwt(accessToken).sid as string;

    const refrescar = (token: string): Promise<import('fastify').LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/auth/refresh',
        remoteAddress: '10.4.0.2',
        payload: { refresh_token: token },
      });
    const listarIds = async (): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/sessions',
        remoteAddress: '10.4.0.3',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return res.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id);
    };

    // A sessão existe antes do reuso.
    expect(await listarIds()).toContain(sessionId);

    // Rotaciona (A→B) e depois reapresenta A: reuso, derruba a família.
    await refrescar(refreshA);
    expect((await refrescar(refreshA)).statusCode).toBe(401);

    // O metadado acompanhou: a sessão sumiu da listagem.
    expect(await listarIds()).not.toContain(sessionId);
  });
});
