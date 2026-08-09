/**
 * As outras duas dimensões, contra o app real e bancos reais.
 *
 * No endpoint de token, a cota é do cliente autenticado — quem varre segredo trocando de IP
 * não escapa. Na verificação de segundo fator, a cota é do **usuário** e não do desafio:
 * sem isso, bastaria pedir um desafio novo para zerar o contador e o teto por tentativa
 * viraria decoração.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { construirApp } from '../../../src/app.js';
import { construirModulos } from '../../../src/bootstrap/composicao.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarClientes, limparClientes } from '../api-clients/schema.js';
import { aplicarMfa, limparMfa } from '../mfa/schema.js';
import {
  criarJwksService,
  criarRepositorioJwks,
  garantirChaveDeBootstrap,
} from '../../../src/modules/jwks/index.js';
import { CABECALHO_FORMULARIO, basic, formulario } from '../oauth/helper-app.js';
import { gerarCodigo, passoDe } from '../../../src/modules/mfa/services/totp.js';
import { decodificarBase32 } from '../../../src/modules/mfa/services/base32.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const SENHA = 'S3nh@Forte!';
const ADMIN = 'rl-dimensoes@iam.local';
const TETO_CLIENTE = 3;
const TETO_MFA = 3;

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let app: FastifyInstance;
let tokenDeAdmin: string;
let ip = 0;

/** IP novo a cada chamada: a dimensão IP nunca entra em cena nestes testes. */
function origem(): string {
  ip += 1;
  return `10.90.${String(Math.floor(ip / 250))}.${String(ip % 250)}`;
}

async function criarCliente(nome: string): Promise<{ client_id: string; client_secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clients',
    headers: { authorization: `Bearer ${tokenDeAdmin}` },
    payload: { name: nome, scopes: ['orders:read'], grant_types: ['client_credentials'] },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ client_id: string; client_secret: string }>();
}

async function pedirToken(clientId: string, secret: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    remoteAddress: origem(),
    headers: { ...CABECALHO_FORMULARIO, authorization: basic(clientId, secret) },
    payload: formulario({ grant_type: 'client_credentials' }),
  });
  return res.statusCode;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 6 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  await aplicarClientes(pool);
  await aplicarMfa(pool);
  await pool.query(
    `INSERT INTO permissions (name) VALUES ('orders:read') ON CONFLICT (name) DO NOTHING`,
  );

  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);

  const env = envDeIntegracao({
    MASTER_KEY: MASTER,
    AUDIT_HINT_PEPPER: PEPPER,
    RATE_LIMIT_OAUTH_CLIENT_MAX: String(TETO_CLIENTE),
    RATE_LIMIT_MFA_ACCOUNT_MAX: String(TETO_MFA),
  });

  const logger = criarLogger({ nivel: 'fatal' });
  const repoJwks = criarRepositorioJwks(pool);
  await garantirChaveDeBootstrap({ repo: repoJwks, masterKey: MASTER, logger });
  const jwks = criarJwksService({ repo: repoJwks, masterKey: MASTER, cacheTtlMs: 300_000 });
  await jwks.iniciar();

  const modulos = construirModulos({ env, pool, banco, jwks, repoJwks, logger });
  app = await construirApp(env, { jwks, modulos, rateLimit: modulos.rateLimit });

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
  const hash = await servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [ADMIN, hash]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'superadmin'`,
    [ADMIN],
  );

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: origem(),
    payload: { email: ADMIN, senha: SENHA },
  });
  tokenDeAdmin = login.json<{ access_token: string }>().access_token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('rate_limit_counters').deleteMany({});
});

describe('limite por cliente no endpoint de token', () => {
  it('a cota é do cliente, mesmo trocando de IP a cada tentativa', async () => {
    await limparClientes(pool);
    const cliente = await criarCliente('rl-cliente-a');

    for (let tentativa = 0; tentativa < TETO_CLIENTE; tentativa += 1) {
      expect(await pedirToken(cliente.client_id, 'segredo-errado')).toBe(401);
    }

    expect(await pedirToken(cliente.client_id, 'segredo-errado')).toBe(429);
  });

  it('clientes diferentes não compartilham cota', async () => {
    await limparClientes(pool);
    const primeiro = await criarCliente('rl-cliente-b');
    const segundo = await criarCliente('rl-cliente-c');

    for (let tentativa = 0; tentativa < TETO_CLIENTE; tentativa += 1) {
      await pedirToken(primeiro.client_id, 'segredo-errado');
    }

    expect(await pedirToken(segundo.client_id, 'segredo-errado')).toBe(401);
  });

  it('o 429 do endpoint de token sai no formato da RFC 6749', async () => {
    await limparClientes(pool);
    const cliente = await criarCliente('rl-cliente-d');
    for (let tentativa = 0; tentativa < TETO_CLIENTE; tentativa += 1) {
      await pedirToken(cliente.client_id, 'segredo-errado');
    }

    const barrada = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      remoteAddress: origem(),
      headers: {
        ...CABECALHO_FORMULARIO,
        authorization: basic(cliente.client_id, 'segredo-errado'),
      },
      payload: formulario({ grant_type: 'client_credentials' }),
    });

    expect(barrada.statusCode).toBe(429);
    expect(barrada.headers['content-type']).not.toContain('problem+json');
    expect(barrada.headers['retry-after']).toBeDefined();
    expect(barrada.json()).toMatchObject({ error: 'slow_down' });
  });

  it('autenticação bem-sucedida não consome cota', async () => {
    await limparClientes(pool);
    const cliente = await criarCliente('rl-cliente-e');

    for (let tentativa = 0; tentativa < TETO_CLIENTE + 2; tentativa += 1) {
      expect(await pedirToken(cliente.client_id, cliente.client_secret)).toBe(200);
    }
  });

  it('nenhum client_id em claro na coleção de contadores', async () => {
    await limparClientes(pool);
    const cliente = await criarCliente('rl-cliente-f');

    await pedirToken(cliente.client_id, 'segredo-errado');

    const documentos = await banco.collection('rate_limit_counters').find({}).toArray();
    expect(JSON.stringify(documentos)).not.toContain(cliente.client_id);
  });
});

describe('limite por conta na verificação de segundo fator', () => {
  /** Cadastra e confirma um fator, devolvendo o segredo. */
  async function habilitarMfa(): Promise<Buffer> {
    const cadastro = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp',
      headers: { authorization: `Bearer ${tokenDeAdmin}` },
      payload: {},
    });
    expect(cadastro.statusCode).toBe(201);
    const segredo = decodificarBase32(cadastro.json<{ secret: string }>().secret);

    const confirmacao = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/confirm',
      headers: { authorization: `Bearer ${tokenDeAdmin}` },
      payload: { code: gerarCodigo(segredo, passoDe(Date.now())) },
    });
    expect(confirmacao.statusCode).toBe(200);
    return segredo;
  }

  /** Um desafio novo, do login com senha correta. */
  async function novoDesafio(): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: origem(),
      payload: { email: ADMIN, senha: SENHA },
    });
    return login.json<{ mfa_token: string }>().mfa_token;
  }

  it('a cota é do usuário e atravessa desafios diferentes', async () => {
    // O teto por desafio já existe e morre com ele; sem a cota por conta, pedir um desafio
    // novo devolveria tentativas e o teto viraria decoração.
    await limparMfa(pool);
    await habilitarMfa();

    for (let tentativa = 0; tentativa < TETO_MFA; tentativa += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        remoteAddress: origem(),
        payload: { mfa_token: await novoDesafio(), code: '000000' },
      });
      expect(res.statusCode).toBe(400);
    }

    // Desafio novo em folha, e ainda assim barrado.
    const barrada = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: origem(),
      payload: { mfa_token: await novoDesafio(), code: '000000' },
    });

    expect(barrada.statusCode).toBe(429);
    expect(barrada.headers['content-type']).toContain('application/problem+json');
  });

  it('verificação correta não consome cota', async () => {
    await limparMfa(pool);
    const segredo = await habilitarMfa();

    for (let tentativa = 0; tentativa < TETO_MFA - 1; tentativa += 1) {
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        remoteAddress: origem(),
        payload: { mfa_token: await novoDesafio(), code: '000000' },
      });
    }

    // O passo seguinte ao consumido na confirmação, para o anti-replay não recusar.
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: origem(),
      payload: {
        mfa_token: await novoDesafio(),
        code: gerarCodigo(segredo, passoDe(Date.now()) + 1),
      },
    });
    expect(ok.statusCode).toBe(200);

    const seguinte = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: origem(),
      payload: { mfa_token: await novoDesafio(), code: '000000' },
    });
    expect(seguinte.statusCode).toBe(400);
  });

  it('token de desafio desconhecido não cria cota de ninguém', async () => {
    // Sem conta identificável não há o que limitar; a resposta é a genérica de sempre.
    await limparMfa(pool);
    await habilitarMfa();

    for (let tentativa = 0; tentativa < TETO_MFA + 2; tentativa += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        remoteAddress: origem(),
        payload: { mfa_token: 'a'.repeat(43), code: '000000' },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
