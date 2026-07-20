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

let app: FastifyInstance;

beforeAll(async () => {
  app = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
  );
});

afterAll(async () => {
  await app.close();
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
