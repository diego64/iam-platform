/**
 * Escrita de política tem de valer na decisão seguinte dentro do mesmo processo. O TTL aqui
 * é longo de propósito: se a decisão mudar, foi por causa do `invalidar()` da escrita e não
 * porque o cache expirou sozinho.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaAbac } from './schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { montarAppDeAbac } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-cache@iam.local';
/** Uma hora: só a invalidação explícita pode mudar a decisão dentro do teste. */
const TTL_LONGO_MS = 3_600_000;

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let headers: { authorization: string };

async function decidir(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/policies/evaluate',
    headers,
    payload: {
      subject: { sub: 'u-1' },
      resource_type: 'contract',
      resource: { owner_id: 'u-1' },
      action: 'read',
    },
  });
  return res.json<{ effect: string }>().effect;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaAbac(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  const montado = await montarAppDeAbac({ pool, banco, ttlDeCacheMs: TTL_LONGO_MS });
  app = montado.app;

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [ADMIN, hash],
  );
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE name = 'superadmin'`,
    [rows[0]?.id ?? ''],
  );

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: '10.4.0.1',
    payload: { email: ADMIN, senha: SENHA },
  });
  headers = { authorization: `Bearer ${login.json<{ access_token: string }>().access_token}` };
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('escrita de política reflete na decisão seguinte', () => {
  it('criar um deny muda permit → deny sem esperar o TTL', async () => {
    // Aquece o cache: a posse permite o dono.
    expect(await decidir()).toBe('permit');

    const criada = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: {
        name: 'deny-contratos',
        effect: 'deny',
        resource_type: 'contract',
        action: 'read',
        condition: { op: 'eq', attr: 'action', value: 'read' },
      },
    });
    expect(criada.statusCode).toBe(201);
    expect(await decidir()).toBe('deny');

    // E desligar o deny devolve o permit, também na hora.
    const id = criada.json<{ id: string }>().id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/policies/${id}`,
      headers,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(await decidir()).toBe('permit');

    // Assim como removê-la de vez.
    await app.inject({
      method: 'PATCH',
      url: `/policies/${id}`,
      headers,
      payload: { enabled: true },
    });
    expect(await decidir()).toBe('deny');
    await app.inject({ method: 'DELETE', url: `/policies/${id}`, headers });
    expect(await decidir()).toBe('permit');
  });
});
