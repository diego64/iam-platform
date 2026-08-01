/**
 * Cobre o fluxo de autenticação de ponta a ponta contra bancos reais: login (200/400/401),
 * acesso autenticado a /auth/me e logout que coloca o jti na denylist e invalida o token.
 *
 * Cada teste usa um IP distinto (`remoteAddress`) para não compartilhar o balde do rate
 * limit — o limite em si é coberto à parte, em rate-limit.test.ts.
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

const EMAIL = 'user@iam.local';
const SENHA = 'S3nh@Forte!';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

/** IP único por chamada, para isolar o rate limit por teste. */
function proximoIp(): string {
  ip += 1;
  return `10.1.0.${String(ip)}`;
}

async function logar(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email: EMAIL, senha: SENHA },
  });
  const corpo = res.json<{ access_token: string; refresh_token: string }>();
  return { accessToken: corpo.access_token, refreshToken: corpo.refresh_token };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

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

describe('POST /auth/login', () => {
  it('200 com o par de tokens para credencial válida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: EMAIL, senha: SENHA },
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<Record<string, unknown>>();
    expect(Object.keys(corpo).sort()).toEqual([
      'access_token',
      'expires_in',
      'refresh_token',
      'token_type',
    ]);
    expect(corpo['token_type']).toBe('Bearer');
    expect(corpo['expires_in']).toBe(900);
  });

  it('400 para corpo inválido (campo extra / senha curta)', async () => {
    const extra = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: EMAIL, senha: SENHA, admin: true },
    });
    const curta = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: EMAIL, senha: '123' },
    });
    expect(extra.statusCode).toBe(400);
    expect(curta.statusCode).toBe(400);
  });

  it('401 genérico para senha errada e para usuário inexistente', async () => {
    const senhaErrada = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: EMAIL, senha: 'ErradaTotal!' },
    });
    const semUsuario = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: 'ninguem@iam.local', senha: 'Qualquer123!' },
    });

    expect(senhaErrada.statusCode).toBe(401);
    expect(semUsuario.statusCode).toBe(401);
    // Mesma mensagem para os dois — sem enumeração.
    expect(senhaErrada.json<{ title: string }>().title).toBe(
      semUsuario.json<{ title: string }>().title,
    );
  });
});

describe('GET /auth/me', () => {
  it('200 com o perfil quando autenticado', async () => {
    const { accessToken } = await logar();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<Record<string, unknown>>();
    expect(corpo['email']).toBe(EMAIL);
    expect(corpo['status']).toBe('active');
    expect(corpo).not.toHaveProperty('password_hash');
  });

  it('401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me', remoteAddress: proximoIp() });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('204 e o access token deixa de valer (denylist)', async () => {
    const { accessToken, refreshToken } = await logar();

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refresh_token: refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const depois = await app.inject({
      method: 'GET',
      url: '/auth/me',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(depois.statusCode).toBe(401);
    expect(depois.json<{ type: string }>().type).toContain('token-revoked');
  });
});
