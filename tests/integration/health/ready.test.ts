/**
 * Cobre GET /health/ready contra dependências reais.
 *
 * É o teste que justifica a SPEC: sem ambiente de homologação, este endpoint é o
 * primeiro e único ponto em que um deploy incapaz de falar com o banco é detectado
 * antes de servir tráfego.
 *
 * Os casos de indisponibilidade apontam os verificadores para portas mortas em vez de
 * parar containers. A primeira versão parava serviços do compose e quebrava de duas
 * formas: derrubava o teste de bootstrap rodando em outro worker, e no CI não existe
 * compose algum — lá são service containers do GitHub Actions, e o .env é gitignored.
 * Porta morta exercita o mesmo caminho, com driver real e recusa real, e funciona em
 * qualquer ambiente.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import { construirApp } from '../../../src/app.js';
import { criarPoolPostgres } from '../../../src/database/postgres/connection.js';
import { criarServicoDeProntidao } from '../../../src/modules/health/services/prontidao.service.js';
import {
  criarVerificadorMongo,
  criarVerificadorPostgres,
} from '../../../src/modules/health/services/verificadores.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

/** Endereços onde nada escuta: produzem recusa imediata, como um banco fora. */
const POSTGRES_MORTO = 'postgres://ninguem@127.0.0.1:1/inexistente';
const MONGO_MORTO = 'mongodb://127.0.0.1:1';

let saudavel: FastifyInstance;
let semPostgres: FastifyInstance;
let semMongo: FastifyInstance;
let semNada: FastifyInstance;

const abertos: { pool: Pool; mongo: MongoClient }[] = [];

/**
 * Monta um app com verificadores apontados para os endereços informados.
 *
 * O MongoClient é criado sem `connect()`: para endereço morto, conectar lançaria no
 * setup em vez de na checagem, e o que se quer exercitar é o verificador registrando a
 * recusa.
 */
async function montarApp(postgresUrl: string, mongoUrl: string): Promise<FastifyInstance> {
  const env = envDeIntegracao({
    HEALTH_CACHE_MS: '0',
    HEALTH_TIMEOUT_MS: '1000',
    POSTGRES_URL: postgresUrl,
    MONGODB_URL: mongoUrl,
  });

  const pool = criarPoolPostgres(env);
  const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 800 });
  abertos.push({ pool, mongo });

  const prontidao = criarServicoDeProntidao({
    verificadores: [
      criarVerificadorPostgres(pool, env.HEALTH_TIMEOUT_MS),
      criarVerificadorMongo(mongo.db(env.MONGODB_DB), env.HEALTH_TIMEOUT_MS),
    ],
    cacheMs: env.HEALTH_CACHE_MS,
    logger: criarLogger({ nivel: 'fatal' }),
  });

  return construirApp(env, { prontidao });
}

beforeAll(async () => {
  const env = envDeIntegracao();
  saudavel = await montarApp(env.POSTGRES_URL, env.MONGODB_URL);
  semPostgres = await montarApp(POSTGRES_MORTO, env.MONGODB_URL);
  semMongo = await montarApp(env.POSTGRES_URL, MONGO_MORTO);
  semNada = await montarApp(POSTGRES_MORTO, MONGO_MORTO);
}, 60_000);

afterAll(async () => {
  for (const app of [saudavel, semPostgres, semMongo, semNada]) {
    await app.close();
  }
  for (const { pool, mongo } of abertos) {
    await pool.end().catch(() => undefined);
    await mongo.close().catch(() => undefined);
  }
});

describe('dependências saudáveis', () => {
  it('responde 200 com status ready e as duas dependências up', async () => {
    const resposta = await saudavel.inject({ method: 'GET', url: '/health/ready' });

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
    const resposta = await saudavel.inject({ method: 'GET', url: '/health/ready' });

    // Sonda que recebe 401 é indistinguível de serviço fora, e o orquestrador tiraria
    // do ar uma instância saudável.
    expect(resposta.statusCode).not.toBe(401);
  });
});

describe('PostgreSQL indisponível', () => {
  it('responde 503 identificando postgres, com mongodb ainda up', async () => {
    const resposta = await semPostgres.inject({ method: 'GET', url: '/health/ready' });
    const corpo = resposta.json<{
      detail: string;
      dependencias: { nome: string; estado: string }[];
    }>();

    expect(resposta.statusCode).toBe(503);
    expect(corpo.detail).toContain('postgres');
    expect(corpo.dependencias.find((d) => d.nome === 'mongodb')?.estado).toBe('up');
  }, 30_000);

  it('responde em problem+json', async () => {
    const resposta = await semPostgres.inject({ method: 'GET', url: '/health/ready' });

    expect(resposta.headers['content-type']).toContain('application/problem+json');
  }, 30_000);

  it('não vaza host, porta nem string de conexão', async () => {
    const bruto = (await semPostgres.inject({ method: 'GET', url: '/health/ready' })).body;

    // A resposta é pública e sem autenticação, e a mensagem do driver traz host e usuário.
    expect(bruto).not.toContain('127.0.0.1');
    expect(bruto).not.toContain('postgres://');
    expect(bruto).not.toContain('ninguem');
    expect(bruto).not.toMatch(/password|senha/i);
  }, 30_000);
});

describe('MongoDB indisponível', () => {
  it('responde 503 identificando mongodb, com postgres ainda up', async () => {
    const resposta = await semMongo.inject({ method: 'GET', url: '/health/ready' });
    const corpo = resposta.json<{
      detail: string;
      dependencias: { nome: string; estado: string }[];
    }>();

    expect(resposta.statusCode).toBe(503);
    expect(corpo.detail).toContain('mongodb');
    expect(corpo.dependencias.find((d) => d.nome === 'postgres')?.estado).toBe('up');
  }, 30_000);
});

describe('ambas indisponíveis', () => {
  it('responde 503 listando as duas', async () => {
    const corpo = (await semNada.inject({ method: 'GET', url: '/health/ready' })).json<{
      detail: string;
    }>();

    expect(corpo.detail).toContain('postgres');
    expect(corpo.detail).toContain('mongodb');
  }, 30_000);
});

describe('liveness segue independente', () => {
  it('responde 200 mesmo com as duas dependências fora', async () => {
    const live = await semNada.inject({ method: 'GET', url: '/health/live' });
    const ready = await semNada.inject({ method: 'GET', url: '/health/ready' });

    // Liveness que checasse banco viraria restart loop e derrubaria também as réplicas
    // que ainda serviam. É por isso que ele não muda.
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  }, 30_000);
});

describe('teto de tempo', () => {
  it('responde dentro do teto mesmo com dependência fora', async () => {
    const inicio = Date.now();
    await semNada.inject({ method: 'GET', url: '/health/ready' });

    // Se a checagem demora mais que o timeout da sonda, o orquestrador mata a
    // requisição e conclui "fora" sem receber o diagnóstico.
    expect(Date.now() - inicio).toBeLessThan(2_500);
  }, 30_000);
});
