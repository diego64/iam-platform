/**
 * Cobre as 7 rotas de /users de ponta a ponta contra PostgreSQL real, com fakes para
 * autorização (001/003) e revogação de sessões (001/006). Reúne criação, leitura, ciclo de
 * status, remoção e autorização num arquivo só para não repetir o setup de schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { montarAppDeUsuario, type AppDeUsuario } from './helper-app.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from './schema.js';

const ADMIN = { 'x-test-admin': 'admin-1' };
const SENHA = 'S3nh@MuitoForte!';

let pool: Pool;
let contexto: AppDeUsuario;
let app: FastifyInstance;

/** Cria um usuário via rota e devolve o id. */
async function criarUsuario(email: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/users',
    headers: ADMIN,
    payload: { email, senha: SENHA },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ id: string }>().id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchema(pool);
});

beforeEach(async () => {
  await limparUsuarios(pool);
  contexto = await montarAppDeUsuario({ pool });
  app = contexto.app;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('POST /users', () => {
  it('cria (201) com DTO sem password_hash', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/users',
      headers: ADMIN,
      payload: { email: 'a@iam.local', senha: SENHA },
    });
    expect(r.statusCode).toBe(201);
    const corpo = r.json<Record<string, unknown>>();
    expect(corpo).toMatchObject({ email: 'a@iam.local', status: 'active' });
    expect(corpo).not.toHaveProperty('passwordHash');
    expect(r.payload).not.toContain('scrypt$');
  });

  it('rejeita e-mail duplicado (409)', async () => {
    await criarUsuario('a@iam.local');
    const r = await app.inject({
      method: 'POST',
      url: '/users',
      headers: ADMIN,
      payload: { email: 'a@iam.local', senha: SENHA },
    });
    expect(r.statusCode).toBe(409);
  });

  it('rejeita senha fraca (400) e campo extra (400)', async () => {
    const fraca = await app.inject({
      method: 'POST',
      url: '/users',
      headers: ADMIN,
      payload: { email: 'a@iam.local', senha: 'fraca' },
    });
    expect(fraca.statusCode).toBe(400);

    const extra = await app.inject({
      method: 'POST',
      url: '/users',
      headers: ADMIN,
      payload: { email: 'a@iam.local', senha: SENHA, status: 'blocked' },
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe('GET /users', () => {
  it('busca por id (200) e 404 em id inexistente', async () => {
    const id = await criarUsuario('a@iam.local');
    const ok = await app.inject({ method: 'GET', url: `/users/${id}`, headers: ADMIN });
    expect(ok.statusCode).toBe(200);

    const nao = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
      headers: ADMIN,
    });
    expect(nao.statusCode).toBe(404);
  });

  it('lista com filtro de status e paginação', async () => {
    const a = await criarUsuario('a@iam.local');
    await criarUsuario('b@iam.local');
    await app.inject({ method: 'POST', url: `/users/${a}/block`, headers: ADMIN });

    const r = await app.inject({
      method: 'GET',
      url: '/users?status=blocked&limit=10',
      headers: ADMIN,
    });
    expect(r.statusCode).toBe(200);
    const corpo = r.json<{ items: unknown[]; total: number }>();
    expect(corpo.total).toBe(1);
    expect(corpo.items).toHaveLength(1);
  });
});

describe('PATCH /users/:id', () => {
  it('troca o e-mail (200) e conflita (409) com e-mail existente', async () => {
    const id = await criarUsuario('a@iam.local');
    await criarUsuario('b@iam.local');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/users/${id}`,
      headers: ADMIN,
      payload: { email: 'c@iam.local' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ email: string }>().email).toBe('c@iam.local');

    const conflito = await app.inject({
      method: 'PATCH',
      url: `/users/${id}`,
      headers: ADMIN,
      payload: { email: 'b@iam.local' },
    });
    expect(conflito.statusCode).toBe(409);
  });
});

describe('ciclo de status e remoção', () => {
  it('bloquear muda status e revoga sessões (porta chamada)', async () => {
    const id = await criarUsuario('a@iam.local');
    const r = await app.inject({ method: 'POST', url: `/users/${id}/block`, headers: ADMIN });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ status: string }>().status).toBe('blocked');
    expect(contexto.sessoes.revogados).toContain(id);
  });

  it('desbloquear volta para active', async () => {
    const id = await criarUsuario('a@iam.local');
    await app.inject({ method: 'POST', url: `/users/${id}/block`, headers: ADMIN });
    const r = await app.inject({ method: 'POST', url: `/users/${id}/unblock`, headers: ADMIN });
    expect(r.json<{ status: string }>().status).toBe('active');
  });

  it('remover (204) revoga sessões e some da base; 404 depois', async () => {
    const id = await criarUsuario('a@iam.local');
    const del = await app.inject({ method: 'DELETE', url: `/users/${id}`, headers: ADMIN });
    expect(del.statusCode).toBe(204);
    expect(contexto.sessoes.revogados).toContain(id);
    const get = await app.inject({ method: 'GET', url: `/users/${id}`, headers: ADMIN });
    expect(get.statusCode).toBe(404);
  });

  it('bloquear id inexistente ⇒ 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/users/00000000-0000-0000-0000-000000000000/block',
      headers: ADMIN,
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('autorização', () => {
  it('sem token ⇒ 401; token sem papel admin ⇒ 403', async () => {
    const semToken = await app.inject({ method: 'GET', url: '/users' });
    expect(semToken.statusCode).toBe(401);

    const semPapel = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { 'x-test-admin': 'no' },
    });
    expect(semPapel.statusCode).toBe(403);
  });

  it('escrita sem autorização não toca a base', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { 'x-test-admin': 'no' },
      payload: { email: 'z@iam.local', senha: SENHA },
    });
    expect(r.statusCode).toBe(403);
    const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', ['z@iam.local']);
    expect(rows).toHaveLength(0);
  });
});
