/**
 * Cobre a rotação de refresh contra bancos reais: login emite o primeiro token; `/auth/refresh`
 * troca por um novo par; a cadeia rotaciona em sequência; reusar um token já rotacionado
 * derruba a família inteira (detecção de roubo); corpo inválido é 400 e o excesso por IP é 429.
 *
 * O helper monta o serviço com `grace` 0 — reuso é detectado de imediato, sem esperar relógio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { montarAppDeAuth } from './helper-app.js';

const EMAIL = 'refresh@iam.local';
const SENHA = 'S3nh@Forte!';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.2.0.${String(ip)}`;
}

async function logar(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email: EMAIL, senha: SENHA },
  });
  return res.json<{ refresh_token: string }>().refresh_token;
}

function refrescar(refreshToken: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/auth/refresh',
    remoteAddress: proximoIp(),
    payload: { refresh_token: refreshToken },
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('refresh_tokens').deleteMany({});

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

describe('POST /auth/refresh', () => {
  it('200 com um novo par, distinto do refresh apresentado', async () => {
    const original = await logar();
    const res = await refrescar(original);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<Record<string, unknown>>();
    expect(Object.keys(corpo).sort()).toEqual([
      'access_token',
      'expires_in',
      'refresh_token',
      'token_type',
    ]);
    expect(corpo['refresh_token']).not.toBe(original);
    expect(corpo['token_type']).toBe('Bearer');
  });

  it('rotaciona a cadeia em sequência (A→B→C)', async () => {
    const a = await logar();
    const b = (await refrescar(a)).json<{ refresh_token: string }>().refresh_token;
    const resC = await refrescar(b);

    expect(resC.statusCode).toBe(200);
    expect(resC.json<{ refresh_token: string }>().refresh_token).not.toBe(b);
  });

  it('reusar um token já rotacionado responde 401 e derruba a família', async () => {
    const a = await logar();
    const b = (await refrescar(a)).json<{ refresh_token: string }>().refresh_token;

    // Reuso do token antigo: 401 e, além disso, revoga a família.
    const reuso = await refrescar(a);
    expect(reuso.statusCode).toBe(401);
    expect(reuso.json<{ type: string }>().type).toContain('invalid-refresh-token');

    // O token que era válido (B) também para de funcionar — a sessão inteira caiu.
    const bDepois = await refrescar(b);
    expect(bDepois.statusCode).toBe(401);
  });

  it('400 para corpo inválido (campo extra ou token fora do tamanho)', async () => {
    const extra = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: proximoIp(),
      payload: { refresh_token: 'x'.repeat(88), sudo: true },
    });
    const curto = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: proximoIp(),
      payload: { refresh_token: 'curto' },
    });
    expect(extra.statusCode).toBe(400);
    expect(curto.statusCode).toBe(400);
  });

  it('401 para token inexistente (mesma resposta genérica)', async () => {
    const res = await refrescar('A'.repeat(88));
    expect(res.statusCode).toBe(401);
  });

  it('429 quando um mesmo IP excede o teto por minuto', async () => {
    const ipFixo = '10.2.9.9';
    let excedeu = false;
    for (let i = 0; i < 31; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        remoteAddress: ipFixo,
        payload: { refresh_token: 'A'.repeat(88) },
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
