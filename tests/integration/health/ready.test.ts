/**
 * Cobre GET /health/ready contra PostgreSQL e MongoDB reais, derrubando cada um.
 *
 * É o teste que justifica a SPEC: sem ambiente de homologação, este endpoint é o
 * primeiro e único ponto em que um deploy incapaz de falar com o banco é detectado
 * antes de servir tráfego.
 *
 * Cada caso que derruba um serviço o restaura depois. Um teste que deixa o PostgreSQL
 * parado faz os seguintes falharem por motivo errado, e o diagnóstico vira caça ao
 * fantasma.
 *
 * Este arquivo manipula infraestrutura COMPARTILHADA, então a suíte de integração roda
 * com --no-file-parallelism. Sem isso, parar o postgres aqui derruba o teste de
 * bootstrap que roda em outro worker ao mesmo tempo — foi exatamente o que aconteceu
 * quando este teste entrou.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import { construirApp } from '../../../src/app.js';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { criarPoolPostgres } from '../../../src/database/postgres/connection.js';
import { criarServicoDeProntidao } from '../../../src/modules/health/services/prontidao.service.js';
import {
  criarVerificadorMongo,
  criarVerificadorPostgres,
} from '../../../src/modules/health/services/verificadores.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

const execFileAsync = promisify(execFile);
const COMPOSE = [
  'compose',
  '-f',
  'infra/compose/docker-compose.test.yml',
  '--env-file',
  'infra/compose/.env',
];

let app: FastifyInstance;
let pool: Pool;
let mongo: MongoClient;

/** Para ou inicia um serviço do compose de teste. */
async function servico(acao: 'stop' | 'start', nome: 'postgres' | 'mongodb'): Promise<void> {
  await execFileAsync('docker', [...COMPOSE, acao, nome]);
}

/** Aguarda o serviço voltar a aceitar conexão, para não contaminar o próximo teste. */
async function aguardarRecuperacao(): Promise<void> {
  const prazo = Date.now() + 30_000;
  while (Date.now() < prazo) {
    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });
    if (resposta.statusCode === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('dependências não voltaram dentro do prazo');
}

beforeAll(async () => {
  const env = envDeIntegracao({ HEALTH_CACHE_MS: '0', HEALTH_TIMEOUT_MS: '1000' });
  pool = criarPoolPostgres(env);
  ({ cliente: mongo } = await conectarMongo(env));

  const prontidao = criarServicoDeProntidao({
    verificadores: [
      criarVerificadorPostgres(pool, env.HEALTH_TIMEOUT_MS),
      criarVerificadorMongo(mongo.db(env.MONGODB_DB), env.HEALTH_TIMEOUT_MS),
    ],
    cacheMs: env.HEALTH_CACHE_MS,
    logger: criarLogger({ nivel: 'fatal' }),
  });

  app = await construirApp(env, { prontidao });
}, 60_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

afterEach(async () => {
  // Restaura os dois independentemente de qual o teste derrubou.
  await servico('start', 'postgres').catch(() => undefined);
  await servico('start', 'mongodb').catch(() => undefined);
}, 60_000);

describe('dependências saudáveis', () => {
  it('responde 200 com status ready e as duas dependências up', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json<{
      status: string;
      dependencias: { nome: string; estado: string }[];
    }>();
    expect(corpo.status).toBe('ready');
    expect(corpo.dependencias.map((d) => d.nome).sort()).toEqual(['mongodb', 'postgres']);
    expect(corpo.dependencias.every((d) => d.estado === 'up')).toBe(true);
  });

  it('não exige autenticação', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    // Sonda que recebe 401 é indistinguível de serviço fora, e o orquestrador tiraria
    // do ar uma instância saudável.
    expect(resposta.statusCode).not.toBe(401);
  });
});

describe('PostgreSQL indisponível', () => {
  it('responde 503 identificando postgres, com mongodb ainda up', async () => {
    await servico('stop', 'postgres');
    await aguardarQueda('postgres');

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });
    const corpo = resposta.json<{
      detail: string;
      dependencias: { nome: string; estado: string }[];
    }>();

    expect(resposta.statusCode).toBe(503);
    expect(corpo.detail).toContain('postgres');
    expect(corpo.dependencias.find((d) => d.nome === 'mongodb')?.estado).toBe('up');
  }, 60_000);

  it('responde em problem+json', async () => {
    await servico('stop', 'postgres');
    await aguardarQueda('postgres');

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.headers['content-type']).toContain('application/problem+json');
  }, 60_000);

  it('não vaza host, usuário nem string de conexão', async () => {
    await servico('stop', 'postgres');
    await aguardarQueda('postgres');

    const bruto = (await app.inject({ method: 'GET', url: '/health/ready' })).body;

    // A resposta é pública e sem autenticação: mensagem de driver traz host e usuário.
    expect(bruto).not.toContain('127.0.0.1');
    expect(bruto).not.toContain('55432');
    expect(bruto).not.toContain('postgres://');
    expect(bruto).not.toMatch(/password|senha/i);
  }, 60_000);
});

describe('MongoDB indisponível', () => {
  it('responde 503 identificando mongodb', async () => {
    await servico('stop', 'mongodb');
    await aguardarQueda('mongodb');

    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });
    const corpo = resposta.json<{ detail: string }>();

    expect(resposta.statusCode).toBe(503);
    expect(corpo.detail).toContain('mongodb');
  }, 60_000);
});

describe('liveness segue independente', () => {
  it('responde 200 com as duas dependências derrubadas', async () => {
    await servico('stop', 'postgres');
    await servico('stop', 'mongodb');

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    // Liveness que checasse banco viraria restart loop e derrubaria também as réplicas
    // que ainda serviam. É por isso que ele não muda.
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  }, 90_000);
});

describe('teto de tempo', () => {
  it('responde dentro do teto mesmo com dependência fora', async () => {
    await servico('stop', 'postgres');
    await aguardarQueda('postgres');

    const inicio = Date.now();
    await app.inject({ method: 'GET', url: '/health/ready' });

    // Se a checagem demora mais que o timeout da sonda, o orquestrador mata a
    // requisição e conclui "fora" sem receber o diagnóstico.
    expect(Date.now() - inicio).toBeLessThan(2_500);
  }, 60_000);
});

/** Espera o readiness refletir a queda, já que o container leva um instante para parar. */
async function aguardarQueda(nome: string): Promise<void> {
  const prazo = Date.now() + 20_000;
  while (Date.now() < prazo) {
    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });
    if (resposta.statusCode === 503 && resposta.body.includes(nome)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`readiness não refletiu a queda de ${nome}`);
}

// Garante que a suíte não termina com serviço parado para as demais.
afterAll(async () => {
  await aguardarRecuperacao().catch(() => undefined);
}, 60_000);
