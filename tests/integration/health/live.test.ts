/**
 * Cobre GET /health/live. O ponto crítico: liveness responde 200 mesmo com os bancos
 * fora — nenhum banco é sequer conectado aqui, e é isso que o teste prova.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv } from '../../../src/config/env.js';

let app: FastifyInstance;

beforeAll(async () => {
  // URLs deliberadamente apontadas para portas mortas: se o liveness tocasse em
  // banco, este teste falharia.
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

describe('GET /health/live', () => {
  it('responde 200 com status ok e uptime inteiro', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json<{ status: string; uptime_seconds: number }>();
    expect(corpo.status).toBe('ok');
    expect(Number.isInteger(corpo.uptime_seconds)).toBe(true);
    expect(corpo.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('responde 200 com PostgreSQL e MongoDB inalcançáveis', async () => {
    // As URLs do app apontam para 127.0.0.1:1. Um liveness que consultasse
    // dependências não teria como responder 200 aqui.
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json<{ status: string }>().status).toBe('ok');
  });

  it('devolve exatamente os campos do contrato, sem vazar extras', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(Object.keys(resposta.json<object>()).sort()).toEqual(['status', 'uptime_seconds']);
  });

  it('não exige autenticação', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.statusCode).not.toBe(401);
  });

  it('aparece no documento OpenAPI servido pelo Swagger', () => {
    const documento = app.swagger() as { paths: Record<string, unknown> };

    expect(documento.paths).toHaveProperty('/health/live');
  });

  it('responde problem+json em rota inexistente', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/inexistente' });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });
});
