/**
 * O formato do 429.
 *
 * Fora de `/oauth/*` ele é problem+json com um tipo próprio — sem isso o cliente precisaria
 * tratar um formato de erro exclusivo desta situação. Dentro de `/oauth/*` ele continua no
 * formato da RFC 6749, que foi decisão da SPEC 012 e não muda aqui.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarClientes, limparClientes } from '../api-clients/schema.js';
import { CABECALHO_FORMULARIO, basic, formulario, montarAppDeOAuth } from '../oauth/helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'rl-resposta@iam.local';

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  await aplicarClientes(pool);
  await pool.query(
    `INSERT INTO permissions (name) VALUES ('orders:read') ON CONFLICT (name) DO NOTHING`,
  );

  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('rate_limit_counters').deleteMany({});

  const montado = await montarAppDeOAuth({ pool, banco });
  app = montado.app;

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [ADMIN, hash]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'superadmin'`,
    [ADMIN],
  );
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: '10.70.0.1',
    payload: { email: ADMIN, senha: SENHA },
  });
  token = login.json<{ access_token: string }>().access_token;
  await limparClientes(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

/** Bate na rota até levar 429 (ou desistir), sempre da mesma origem. */
async function forcar429(
  chamada: () => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>,
  tentativas: number,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  let ultima = await chamada();
  for (let i = 0; i < tentativas && ultima.statusCode !== 429; i += 1) {
    ultima = await chamada();
  }
  return ultima;
}

describe('429 fora de /oauth', () => {
  it('sai como problem+json com tipo próprio e Retry-After', async () => {
    const excedida = await forcar429(
      () =>
        app.inject({
          method: 'POST',
          url: '/auth/login',
          remoteAddress: '10.70.0.9',
          payload: { email: ADMIN, senha: 'errada' },
        }),
      20,
    );

    expect(excedida.statusCode).toBe(429);
    expect(excedida.headers['content-type']).toContain('application/problem+json');
    expect(excedida.headers['retry-after']).toBeDefined();
    expect(excedida.json()).toMatchObject({
      type: expect.stringContaining('rate-limit-exceeded') as unknown,
      status: 429,
    });
  });

  it('o corpo não diz qual dimensão estourou', async () => {
    // Dizer "o limite desta conta" confirmaria a conta a quem sonda; "deste IP" ensina a
    // trocar de IP.
    const excedida = await forcar429(
      () =>
        app.inject({
          method: 'POST',
          url: '/auth/login',
          remoteAddress: '10.70.0.10',
          payload: { email: ADMIN, senha: 'errada' },
        }),
      20,
    );

    const corpo = JSON.stringify(excedida.json());
    expect(corpo).not.toContain('conta');
    expect(corpo).not.toContain('ip');
    expect(corpo).not.toContain(ADMIN);
  });
});

describe('429 em /oauth', () => {
  it('continua no formato da RFC 6749', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'rl-oauth', scopes: ['orders:read'], grant_types: ['client_credentials'] },
    });
    const cliente = criado.json<{ client_id: string; client_secret: string }>();

    const excedida = await forcar429(
      () =>
        app.inject({
          method: 'POST',
          url: '/oauth/token',
          remoteAddress: '10.70.0.11',
          headers: {
            ...CABECALHO_FORMULARIO,
            authorization: basic(cliente.client_id, cliente.client_secret),
          },
          payload: formulario({ grant_type: 'client_credentials' }),
        }),
      40,
    );

    expect(excedida.statusCode).toBe(429);
    expect(excedida.headers['content-type']).not.toContain('problem+json');
    expect(excedida.json()).toMatchObject({ error: 'slow_down' });
  });
});
