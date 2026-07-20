/**
 * Contrato: a resposta real de /health/live tem que bater com openapi/openapi.yaml.
 *
 * Sem isto, o OpenAPI vira documentação decorativa — consumidor gera cliente a partir
 * do contrato publicado e descobre a divergência em produção.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarEnv } from '../../src/config/env.js';
import type { ServicoDeProntidao } from '../../src/modules/health/services/prontidao.service.js';

let app: FastifyInstance;
let appPronto: FastifyInstance;

/** Prontidão controlável, para exercitar 200 e 503 sem depender de banco. */
function prontidaoFalsa(pronto: boolean): ServicoDeProntidao {
  return {
    consultar: () =>
      Promise.resolve({
        pronto,
        encerrando: false,
        dependencias: [
          {
            nome: 'postgres' as const,
            estado: pronto ? ('up' as const) : ('down' as const),
            duracao_ms: 2,
          },
          { nome: 'mongodb' as const, estado: 'up' as const, duracao_ms: 3 },
        ],
      }),
    marcarEncerrando: () => undefined,
  };
}

beforeAll(async () => {
  app = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
  );

  appPronto = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
    { prontidao: prontidaoFalsa(true) },
  );
});

afterAll(async () => {
  await app.close();
  await appPronto.close();
});

/** Lê o openapi.yaml como texto — evita dependência nova só para parsear YAML. */
function documentoOpenApi(): string {
  return readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');
}

describe('contrato /health/live', () => {
  it('a rota está declarada no openapi.yaml', () => {
    expect(documentoOpenApi()).toContain('/health/live:');
  });

  it('os campos da resposta real são exatamente os exigidos pelo contrato', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });
    const corpo = resposta.json<Record<string, unknown>>();

    // required: [status, uptime_seconds] com additionalProperties: false
    expect(Object.keys(corpo).sort()).toEqual(['status', 'uptime_seconds']);
  });

  it('os tipos da resposta real batem com o contrato', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/health/live' })).json<{
      status: unknown;
      uptime_seconds: unknown;
    }>();

    expect(corpo.status).toBe('ok');
    expect(Number.isInteger(corpo.uptime_seconds)).toBe(true);
  });

  it('o documento servido pelo Swagger declara a mesma rota do arquivo versionado', () => {
    const servido = app.swagger() as { paths: Record<string, unknown> };

    expect(Object.keys(servido.paths)).toContain('/health/live');
    expect(documentoOpenApi()).toContain('/health/live:');
  });
});

describe('contrato /health/ready', () => {
  it('a rota está declarada no openapi.yaml', () => {
    expect(documentoOpenApi()).toContain('/health/ready:');
  });

  it('a resposta 200 traz exatamente os campos do contrato', async () => {
    const corpo = (await appPronto.inject({ method: 'GET', url: '/health/ready' })).json<
      Record<string, unknown>
    >();

    expect(Object.keys(corpo).sort()).toEqual(['dependencias', 'status']);
    expect(corpo['status']).toBe('ready');
  });

  it('cada dependência traz apenas nome, estado e duração', async () => {
    const corpo = (await appPronto.inject({ method: 'GET', url: '/health/ready' })).json<{
      dependencias: Record<string, unknown>[];
    }>();

    for (const dependencia of corpo.dependencias) {
      expect(Object.keys(dependencia).sort()).toEqual(['duracao_ms', 'estado', 'nome']);
    }
  });

  it('a resposta 503 sai em problem+json com os campos do RFC 7807', async () => {
    // O app padrão sobe sem prontidão injetada: readiness responde 503, que é a
    // resposta honesta para instância sem dependências configuradas.
    const resposta = await app.inject({ method: 'GET', url: '/health/ready' });
    const corpo = resposta.json<Record<string, unknown>>();

    expect(resposta.statusCode).toBe(503);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
    expect(corpo).toHaveProperty('type');
    expect(corpo).toHaveProperty('title');
    expect(corpo).toHaveProperty('status', 503);
  });

  it('o documento servido pelo Swagger declara a rota', () => {
    const servido = appPronto.swagger() as { paths: Record<string, unknown> };

    expect(Object.keys(servido.paths)).toContain('/health/ready');
  });

  it('o contrato publicado documenta 200 e 503', () => {
    const doc = documentoOpenApi();
    const trecho = doc.slice(doc.indexOf('/health/ready:'));

    expect(trecho).toContain("'200'");
    expect(trecho).toContain("'503'");
  });
});
