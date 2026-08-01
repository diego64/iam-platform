/**
 * Cobre as rotas de sessão contra bancos reais: listar as próprias marcando a atual; encerrar
 * uma sessão e ver o refresh daquela família cair; 404 uniforme para sessão de outro usuário
 * ou inexistente; e "encerrar as demais" preservando a sessão corrente.
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

const EMAIL = 'sess@iam.local';
const OUTRO_EMAIL = 'sess-outro@iam.local';
const SENHA = 'S3nh@Forte!';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.3.0.${String(ip)}`;
}

interface Login {
  readonly accessToken: string;
  readonly refreshToken: string;
}

async function logar(email: string): Promise<Login> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email, senha: SENHA },
  });
  const corpo = res.json<{ access_token: string; refresh_token: string }>();
  return { accessToken: corpo.access_token, refreshToken: corpo.refresh_token };
}

interface SessaoListada {
  readonly id: string;
  readonly current: boolean;
}

/** Id da sessão corrente, lido do claim `sid` do access token. */
function sidDe(accessToken: string): string {
  const sid = decodeJwt(accessToken).sid;
  if (typeof sid !== 'string') throw new Error('token sem sid');
  return sid;
}

async function listar(accessToken: string): Promise<SessaoListada[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    remoteAddress: proximoIp(),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ sessions: SessaoListada[] }>().sessions;
}

function refrescar(refreshToken: string): Promise<import('fastify').LightMyRequestResponse> {
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
  await banco.collection('active_sessions').deleteMany({});

  let servicoDeSenha;
  ({ app, servicoDeSenha } = await montarAppDeAuth({ pool, banco }));
  const hash = await servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2), ($3, $2)', [
    EMAIL,
    hash,
    OUTRO_EMAIL,
  ]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('GET /auth/sessions', () => {
  it('lista as próprias sessões marcando exatamente uma como atual', async () => {
    const a = await logar(EMAIL);
    await logar(EMAIL); // segunda sessão do mesmo usuário

    const sessoes = await listar(a.accessToken);
    expect(sessoes.length).toBeGreaterThanOrEqual(2);
    expect(sessoes.filter((s) => s.current)).toHaveLength(1);
  });

  it('401 sem token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      remoteAddress: proximoIp(),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /auth/sessions/:id', () => {
  it('encerra uma sessão e o refresh daquela família passa a 401', async () => {
    const a = await logar(EMAIL);
    const b = await logar(EMAIL);
    const idB = sidDe(b.accessToken); // a sessão exata de B, não uma qualquer não-atual

    // A lista de A enxerga a sessão de B como não-atual.
    const sessoes = await listar(a.accessToken);
    expect(sessoes.some((s) => s.id === idB && !s.current)).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${idB}`,
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    // O refresh da família de B não vale mais.
    expect((await refrescar(b.refreshToken)).statusCode).toBe(401);
  });

  it('404 para id inexistente e para sessão de outro usuário, sem revogar', async () => {
    const a = await logar(EMAIL);
    const outro = await logar(OUTRO_EMAIL);
    const sessaoDoOutro = (await listar(outro.accessToken)).find((s) => s.current)?.id;
    expect(sessaoDoOutro).toBeDefined();

    const inexistente = await app.inject({
      method: 'DELETE',
      url: '/auth/sessions/00000000-0000-7000-8000-000000000000',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const alheia = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${sessaoDoOutro ?? ''}`,
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(inexistente.statusCode).toBe(404);
    expect(alheia.statusCode).toBe(404);

    // A sessão do outro segue viva: o refresh dele ainda roda.
    expect((await refrescar(outro.refreshToken)).statusCode).toBe(200);
  });

  it('400 para id que não é UUID', async () => {
    const a = await logar(EMAIL);
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/sessions/nao-e-uuid',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /auth/sessions', () => {
  it('encerra as demais e preserva a atual', async () => {
    const a = await logar(EMAIL);
    const b = await logar(EMAIL);
    await logar(EMAIL);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/sessions',
      remoteAddress: proximoIp(),
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revogadas: number }>().revogadas).toBeGreaterThanOrEqual(1);

    // A sessão atual (A) segue válida; as outras (B) não.
    expect((await refrescar(a.refreshToken)).statusCode).toBe(200);
    expect((await refrescar(b.refreshToken)).statusCode).toBe(401);
  });
});
