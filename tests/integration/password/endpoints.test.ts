/**
 * Cobre as rotas de senha de ponta a ponta contra Mongo e PG reais (token de reset e
 * histórico), com fakes para usuário/sessões/notificação/auth.
 *
 * Reúne change, forgot e reset num arquivo só para não repetir três vezes o setup de
 * schema PG — os casos exigidos por tests.md estão todos aqui.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { criarRepositorioDeUsuarioFake, type RepositorioDeUsuarioFake } from '../../mocks/senha.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { montarAppDeSenha, type AppDeSenha } from './helper-app.js';

const DDL_HISTORY = readFileSync(
  new URL('../../../src/database/migrations/0003_create_password_history.sql', import.meta.url),
  'utf8',
);
const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
const SENHA_ATUAL = 'S3nh@Atual!23';
const SENHA_NOVA = 'N0v@Senh@Forte!';
const EMAIL = 'user@iam.local';

let cliente: MongoClient;
let banco: Db;
let pool: Pool;
let usuarios: RepositorioDeUsuarioFake;
let contexto: AppDeSenha;
let app: FastifyInstance;
let userId: string;

/** Semeia um usuário real no PG (para o FK do histórico) e no fake (para o serviço). */
async function semear(status: 'active' | 'blocked' = 'active'): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users DEFAULT VALUES RETURNING id',
  );
  userId = rows[0]?.id ?? '';
  const hash = await servicoDeSenha.gerarHash(SENHA_ATUAL);
  usuarios.semear({ id: userId, email: EMAIL, status, passwordHash: hash });
}

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);

  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await pool.query('DROP TABLE IF EXISTS password_history');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.query('CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid())');
  await pool.query(DDL_HISTORY);
});

// App e fake recriados por teste: o fake de usuário e o PG precisam partir do mesmo
// estado limpo, senão um usuário órfão no fake fura o FK do histórico no teste seguinte.
beforeEach(async () => {
  await banco.collection('password_reset_tokens').deleteMany({});
  await pool.query('DELETE FROM password_history');
  await pool.query('DELETE FROM users');

  usuarios = criarRepositorioDeUsuarioFake();
  contexto = await montarAppDeSenha({ banco, pool, usuarios });
  app = contexto.app;
});

afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS password_history');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.end();
  await cliente.close();
});

describe('POST /auth/password/change', () => {
  it('204 no feliz e revoga sessões', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { 'x-test-user-id': userId },
      payload: { senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA },
    });

    expect(r.statusCode).toBe(204);
    expect(contexto.sessoes.revogados).toContain(userId);
  });

  it('401 sem autenticação', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      payload: { senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA },
    });

    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
  });

  it('401 com senha atual errada', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { 'x-test-user-id': userId },
      payload: { senha_atual: 'errada!!', senha_nova: SENHA_NOVA },
    });

    expect(r.statusCode).toBe(401);
  });

  it('400 com senha nova fraca (política na borda)', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { 'x-test-user-id': userId },
      payload: { senha_atual: SENHA_ATUAL, senha_nova: 'fraca' },
    });

    expect(r.statusCode).toBe(400);
  });

  it('400 com campo extra (Zod strict)', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { 'x-test-user-id': userId },
      payload: { senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA, admin: true },
    });

    expect(r.statusCode).toBe(400);
  });
});

describe('POST /auth/password/forgot', () => {
  it('202 e gera token para e-mail existente', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: EMAIL },
    });

    expect(r.statusCode).toBe(202);
    expect(contexto.notificacao.enviados.at(-1)?.email).toBe(EMAIL);
    expect(await banco.collection('password_reset_tokens').countDocuments()).toBe(1);
  });

  it('202 idêntico para e-mail inexistente, sem gerar token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'ninguem@iam.local' },
    });

    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({
      message: 'Se o e-mail existir, enviaremos instruções de recuperação.',
    });
    expect(await banco.collection('password_reset_tokens').countDocuments()).toBe(0);
  });
});

describe('POST /auth/password/reset', () => {
  async function pedirToken(): Promise<string> {
    await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: EMAIL } });
    const token = contexto.notificacao.enviados.at(-1)?.token;
    if (token === undefined) throw new Error('sem token');
    return token;
  }

  it('204 no feliz e o token não serve de novo', async () => {
    await semear();
    const token = await pedirToken();

    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, senha_nova: SENHA_NOVA },
    });
    expect(r1.statusCode).toBe(204);

    const r2 = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, senha_nova: 'Outr@Senh@123!' },
    });
    expect(r2.statusCode).toBe(400);
  });

  it('400 com token inexistente', async () => {
    await semear();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token: 'a'.repeat(43), senha_nova: SENHA_NOVA },
    });

    expect(r.statusCode).toBe(400);
  });
});

describe('GET /auth/password/policy', () => {
  it('expõe as regras vigentes', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/password/policy' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ min_length: 12, required_classes: 3 });
  });
});
