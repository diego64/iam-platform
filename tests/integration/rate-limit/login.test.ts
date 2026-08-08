/**
 * O limite por conta no login — o buraco que esta SPEC existe para fechar.
 *
 * O teto por IP não vê um ataque distribuído: mil endereços contra a mesma conta passam por
 * ele sem tocar em nada. O teto por conta é o que barra, e ele só conta tentativa falha,
 * senão quem usa muito o app se auto-bloqueia.
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
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import {
  criarJwksService,
  criarRepositorioJwks,
  garantirChaveDeBootstrap,
} from '../../../src/modules/jwks/index.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';

const SENHA = 'S3nh@Forte!';
const VITIMA = 'rl-vitima@iam.local';
const OUTRA = 'rl-outra@iam.local';
const TETO_POR_CONTA = 4;

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

/** Cada chamada de um IP novo: o teto por IP nunca entra em cena. */
async function tentar(email: string, senha: string): Promise<number> {
  ip += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: `10.80.${String(Math.floor(ip / 250))}.${String(ip % 250)}`,
    payload: { email, senha },
  });
  return res.statusCode;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);

  const env = {
    ...envDeIntegracao(),
    AUDIT_HINT_PEPPER: 'pepper-de-teste-com-mais-de-32-bytes-aqui',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: TETO_POR_CONTA,
    RATE_LIMIT_LOGIN_WINDOW_MS: 60_000,
  };

  const logger = criarLogger({ nivel: 'fatal' });
  const repoJwks = criarRepositorioJwks(pool);
  await garantirChaveDeBootstrap({ repo: repoJwks, masterKey: env.MASTER_KEY ?? '', logger });
  const jwks = criarJwksService({
    repo: repoJwks,
    masterKey: env.MASTER_KEY ?? '',
    cacheTtlMs: 300_000,
  });
  await jwks.iniciar();

  const modulos = construirModulos({ env, pool, banco, jwks, repoJwks, logger });
  app = await construirApp(env, { jwks, modulos, rateLimit: modulos.rateLimit });

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
  const hash = await servicoDeSenha.gerarHash(SENHA);
  for (const email of [VITIMA, OUTRA]) {
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('rate_limit_counters').deleteMany({});
});

describe('limite por conta', () => {
  it('barra o ataque distribuído: cada tentativa de um IP diferente', async () => {
    for (let tentativa = 0; tentativa < TETO_POR_CONTA; tentativa += 1) {
      expect(await tentar(VITIMA, 'S3nh@Errada!')).toBe(401);
    }

    // A seguinte vem de outro IP ainda, e mesmo assim é barrada.
    expect(await tentar(VITIMA, 'S3nh@Errada!')).toBe(429);
  });

  it('contas diferentes não compartilham cota', async () => {
    for (let tentativa = 0; tentativa < TETO_POR_CONTA; tentativa += 1) {
      await tentar(VITIMA, 'S3nh@Errada!');
    }

    expect(await tentar(OUTRA, 'S3nh@Errada!')).toBe(401);
  });

  it('sucesso não consome cota', async () => {
    // Três falhas, um acerto, mais uma falha: se o acerto contasse, esta última seria 429.
    for (let tentativa = 0; tentativa < TETO_POR_CONTA - 1; tentativa += 1) {
      expect(await tentar(VITIMA, 'S3nh@Errada!')).toBe(401);
    }
    expect(await tentar(VITIMA, SENHA)).toBe(200);

    expect(await tentar(VITIMA, 'S3nh@Errada!')).toBe(401);
  });

  it('a conta barrada recebe problem+json com Retry-After', async () => {
    for (let tentativa = 0; tentativa < TETO_POR_CONTA; tentativa += 1) {
      await tentar(VITIMA, 'S3nh@Errada!');
    }

    ip += 1;
    const barrada = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.81.0.1',
      payload: { email: VITIMA, senha: 'S3nh@Errada!' },
    });

    expect(barrada.statusCode).toBe(429);
    expect(barrada.headers['content-type']).toContain('application/problem+json');
    expect(barrada.headers['retry-after']).toBeDefined();
    expect(barrada.json()).toMatchObject({ status: 429 });
  });

  it('a cota é da conta mesmo com caixa diferente no e-mail', async () => {
    for (let tentativa = 0; tentativa < TETO_POR_CONTA; tentativa += 1) {
      await tentar(VITIMA, 'S3nh@Errada!');
    }

    expect(await tentar(VITIMA.toUpperCase(), 'S3nh@Errada!')).toBe(429);
  });

  it('nenhum e-mail em claro na coleção de contadores', async () => {
    await tentar(VITIMA, 'S3nh@Errada!');

    const documentos = await banco.collection('rate_limit_counters').find({}).toArray();
    expect(JSON.stringify(documentos)).not.toContain(VITIMA);
  });
});
