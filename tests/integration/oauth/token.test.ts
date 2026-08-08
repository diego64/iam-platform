/**
 * Endpoint de token contra o app real e bancos reais.
 *
 * Cobre os três grants ponta a ponta, o formato de erro da RFC 6749 (que não pode ser o
 * problem+json do resto da plataforma), o rebaixamento de autoridade no `password` grant, o
 * vínculo do refresh com o cliente e as travas de tipo de mídia e de cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { decodeJwt, jwtVerify, createLocalJWKSet } from 'jose';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarClientes, limparClientes } from '../api-clients/schema.js';
import {
  AUDIENCIA,
  CABECALHO_FORMULARIO,
  EMISSOR,
  basic,
  formulario,
  montarAppDeOAuth,
  type AppDeOAuth,
} from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-oauth@iam.local';

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let montado: AppDeOAuth;
let app: FastifyInstance;
let tokenDeAdmin: string;
let ip = 0;

interface ClienteCriado {
  readonly id: string;
  readonly client_id: string;
  readonly client_secret: string;
}

async function criarCliente(
  nome: string,
  escopos: string[],
  grants: string[],
): Promise<ClienteCriado> {
  const res = await app.inject({
    method: 'POST',
    url: '/clients',
    headers: { authorization: `Bearer ${tokenDeAdmin}` },
    payload: { name: nome, scopes: escopos, grant_types: grants },
  });
  expect(res.statusCode).toBe(201);
  return res.json<ClienteCriado>();
}

async function pedirToken(
  campos: Record<string, string>,
  cabecalhos: Record<string, string> = {},
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  ip += 1;
  return app.inject({
    method: 'POST',
    url: '/oauth/token',
    remoteAddress: `10.20.0.${String(ip % 250)}`,
    headers: { ...CABECALHO_FORMULARIO, ...cabecalhos },
    payload: formulario(campos),
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  await aplicarClientes(pool);
  await pool.query(
    `INSERT INTO permissions (name) VALUES ('orders:read'), ('orders:write')
     ON CONFLICT (name) DO NOTHING`,
  );

  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('refresh_tokens').deleteMany({});

  montado = await montarAppDeOAuth({ pool, banco });
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
    remoteAddress: '10.19.0.1',
    payload: { email: ADMIN, senha: SENHA },
  });
  tokenDeAdmin = login.json<{ access_token: string }>().access_token;
  await limparClientes(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

describe('grant client_credentials', () => {
  it('emite um token verificável pelo JWKS, sem refresh', async () => {
    const cliente = await criarCliente('cc-basico', ['orders:read'], ['client_credentials']);

    const res = await pedirToken(
      { grant_type: 'client_credentials' },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ access_token: string; scope: string; refresh_token?: string }>();
    expect(corpo.scope).toBe('orders:read');
    expect(corpo.refresh_token).toBeUndefined();

    const publico = await montado.jwks.obterConjuntoPublico();
    const conjunto = createLocalJWKSet({ keys: publico.keys });
    const { payload } = await jwtVerify(corpo.access_token, conjunto, {
      algorithms: ['EdDSA'],
      issuer: EMISSOR,
      audience: AUDIENCIA,
    });
    expect(payload.sub).toBe(cliente.client_id);
    expect(payload.sub_type).toBe('client');
    expect(payload.perm).toEqual(['orders:read']);
    expect(payload).not.toHaveProperty('roles');
  });

  it('aceita a credencial pelo corpo', async () => {
    const cliente = await criarCliente('cc-corpo', ['orders:read'], ['client_credentials']);

    const res = await pedirToken({
      grant_type: 'client_credentials',
      client_id: cliente.client_id,
      client_secret: cliente.client_secret,
    });

    expect(res.statusCode).toBe(200);
  });

  it('não devolve cache em nenhuma resposta', async () => {
    const cliente = await criarCliente('cc-cache', ['orders:read'], ['client_credentials']);

    const ok = await pedirToken(
      { grant_type: 'client_credentials' },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );
    const erro = await pedirToken(
      { grant_type: 'client_credentials' },
      { authorization: basic(cliente.client_id, 'segredo-errado') },
    );

    for (const res of [ok, erro]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.pragma).toBe('no-cache');
    }
  });

  it('grant fora dos grant_types do cliente é recusado', async () => {
    const cliente = await criarCliente('cc-so-cc', ['orders:read'], ['client_credentials']);

    const res = await pedirToken(
      { grant_type: 'password', username: ADMIN, password: SENHA },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unauthorized_client');
  });
});

describe('autenticação do cliente', () => {
  it('segredo errado, cliente inexistente e cliente desabilitado dão a mesma resposta', async () => {
    const cliente = await criarCliente('auth-generico', ['orders:read'], ['client_credentials']);
    const desabilitado = await criarCliente(
      'auth-desabilitado',
      ['orders:read'],
      ['client_credentials'],
    );
    await app.inject({
      method: 'PATCH',
      url: `/clients/${desabilitado.id}`,
      headers: { authorization: `Bearer ${tokenDeAdmin}` },
      payload: { status: 'disabled' },
    });

    const respostas = await Promise.all([
      pedirToken(
        { grant_type: 'client_credentials' },
        { authorization: basic(cliente.client_id, 'errado') },
      ),
      pedirToken(
        { grant_type: 'client_credentials' },
        { authorization: basic('cli_nao_existe', 'errado') },
      ),
      pedirToken(
        { grant_type: 'client_credentials' },
        { authorization: basic(desabilitado.client_id, desabilitado.client_secret) },
      ),
    ]);

    for (const res of respostas) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Falha na autenticação do cliente.',
      });
      expect(res.headers['www-authenticate']).toBe('Basic realm="iam"');
    }
  });

  it('sem credencial nenhuma responde invalid_client', async () => {
    const res = await pedirToken({ grant_type: 'client_credentials' });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('invalid_client');
  });

  it('os dois métodos juntos são recusados', async () => {
    const cliente = await criarCliente('auth-duplo', ['orders:read'], ['client_credentials']);

    const res = await pedirToken(
      {
        grant_type: 'client_credentials',
        client_id: cliente.client_id,
        client_secret: cliente.client_secret,
      },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_request');
  });
});

describe('grant password', () => {
  it('rebaixa o superadmin ao escopo do cliente', async () => {
    const cliente = await criarCliente('pwd-rebaixa', ['orders:read'], ['password']);

    const res = await pedirToken(
      { grant_type: 'password', username: ADMIN, password: SENHA },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ access_token: string; scope: string; refresh_token: string }>();
    expect(corpo.scope).toBe('orders:read');
    expect(corpo.refresh_token).toBeTruthy();

    // O usuário é superadmin e tem o curinga; o token sai com o escopo do cliente.
    const payload = decodeJwt(corpo.access_token);
    expect(payload.perm).toEqual(['orders:read']);
    expect(payload.sub_type).toBe('user');
    expect(payload.client_id).toBe(cliente.client_id);
  });

  it('senha errada e usuário inexistente dão o mesmo invalid_grant', async () => {
    const cliente = await criarCliente('pwd-generico', ['orders:read'], ['password']);
    const cabecalho = { authorization: basic(cliente.client_id, cliente.client_secret) };

    const respostas = await Promise.all([
      pedirToken({ grant_type: 'password', username: ADMIN, password: 'errada' }, cabecalho),
      pedirToken(
        { grant_type: 'password', username: 'ninguem@iam.local', password: SENHA },
        cabecalho,
      ),
    ]);

    for (const res of respostas) {
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_grant');
    }
  });

  it('escopo fora do cliente é invalid_scope', async () => {
    const cliente = await criarCliente('pwd-escopo', ['orders:read'], ['password']);

    const res = await pedirToken(
      { grant_type: 'password', username: ADMIN, password: SENHA, scope: 'orders:write' },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_scope');
  });
});

describe('grant refresh_token', () => {
  async function parInicial(cliente: ClienteCriado): Promise<string> {
    const res = await pedirToken(
      { grant_type: 'password', username: ADMIN, password: SENHA },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );
    expect(res.statusCode).toBe(200);
    return res.json<{ refresh_token: string }>().refresh_token;
  }

  it('rotaciona e devolve um sucessor diferente', async () => {
    const cliente = await criarCliente('rt-feliz', ['orders:read'], ['password', 'refresh_token']);
    const refresh = await parInicial(cliente);

    const res = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refresh },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ refresh_token: string; scope: string }>();
    expect(corpo.refresh_token).not.toBe(refresh);
    expect(corpo.scope).toBe('orders:read');
  });

  it('o refresh de um cliente não vale para outro, e a família do dono sobrevive', async () => {
    const dono = await criarCliente('rt-dono', ['orders:read'], ['password', 'refresh_token']);
    const outro = await criarCliente('rt-outro', ['orders:read'], ['refresh_token']);
    const refresh = await parInicial(dono);

    const invasao = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refresh },
      { authorization: basic(outro.client_id, outro.client_secret) },
    );

    expect(invasao.statusCode).toBe(400);
    expect(invasao.json<{ error: string }>().error).toBe('invalid_grant');

    // A recusa não pode ter derrubado a família: o dono continua renovando.
    const legitima = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refresh },
      { authorization: basic(dono.client_id, dono.client_secret) },
    );
    expect(legitima.statusCode).toBe(200);
  });

  it('o refresh nascido no login por senha não é resgatável no endpoint de token', async () => {
    const cliente = await criarCliente('rt-web', ['orders:read'], ['refresh_token']);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.19.0.9',
      payload: { email: ADMIN, senha: SENHA },
    });
    const refreshDaWeb = login.json<{ refresh_token: string }>().refresh_token;

    const res = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refreshDaWeb },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_grant');
  });

  it('o refresh de um cliente não é resgatável em /auth/refresh', async () => {
    const cliente = await criarCliente('rt-so-oauth', ['orders:read'], ['password']);
    const refresh = await parInicial(cliente);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: '10.19.0.10',
      payload: { refresh_token: refresh },
    });

    expect(res.statusCode).toBe(401);
  });

  it('reapresentar o token gasto derruba a família', async () => {
    const cliente = await criarCliente('rt-reuso', ['orders:read'], ['password', 'refresh_token']);
    const refresh = await parInicial(cliente);
    const cabecalho = { authorization: basic(cliente.client_id, cliente.client_secret) };

    const primeira = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refresh },
      cabecalho,
    );
    const sucessor = primeira.json<{ refresh_token: string }>().refresh_token;

    const reuso = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: refresh },
      cabecalho,
    );
    expect(reuso.statusCode).toBe(400);

    // A família caiu junto: o sucessor legítimo também deixa de valer.
    const depois = await pedirToken(
      { grant_type: 'refresh_token', refresh_token: sucessor },
      cabecalho,
    );
    expect(depois.statusCode).toBe(400);
  });
});

describe('travas do endpoint', () => {
  it('corpo em JSON é recusado', async () => {
    const cliente = await criarCliente('trava-json', ['orders:read'], ['client_credentials']);

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'content-type': 'application/json',
        authorization: basic(cliente.client_id, cliente.client_secret),
      },
      payload: { grant_type: 'client_credentials' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_request');
  });

  it('erro sai no formato da RFC 6749, nunca em problem+json', async () => {
    const res = await pedirToken({ grant_type: 'client_credentials' });

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-type']).not.toContain('problem+json');
    expect(res.json()).toHaveProperty('error_description');
  });

  it('grant desconhecido é unsupported_grant_type', async () => {
    const cliente = await criarCliente('trava-grant', ['orders:read'], ['client_credentials']);

    const res = await pedirToken(
      { grant_type: 'authorization_code' },
      { authorization: basic(cliente.client_id, cliente.client_secret) },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unsupported_grant_type');
  });

  it('credencial na querystring não autentica', async () => {
    const cliente = await criarCliente('trava-query', ['orders:read'], ['client_credentials']);

    const res = await app.inject({
      method: 'POST',
      url: `/oauth/token?client_id=${cliente.client_id}&client_secret=${cliente.client_secret}`,
      headers: CABECALHO_FORMULARIO,
      payload: formulario({ grant_type: 'client_credentials' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('invalid_client');
  });

  it('o formulário vale só em /oauth: o login continua exigindo JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: CABECALHO_FORMULARIO,
      remoteAddress: '10.19.0.20',
      payload: formulario({ email: ADMIN, senha: SENHA }),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toContain('problem+json');
  });
});
