/**
 * Contrato: o que o `/metrics` responde tem que bater com o `openapi/openapi.yaml`.
 *
 * Sem isto o OpenAPI vira documentação decorativa — alguém gera cliente ou monitoramento
 * a partir do contrato publicado e descobre a divergência em produção.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../src/telemetry/sdk.js';

const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

function env(sobrescritas: Record<string, string> = {}): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    ...sobrescritas,
  });
}

/** Bloco YAML da rota `/metrics`, até o próximo path de mesma indentação. */
function blocoDeMetrics(): string {
  const inicio = contrato.indexOf('\n  /metrics:');
  expect(inicio).toBeGreaterThan(-1);

  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}\/[\w-]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

let telemetria: Telemetria;
let app: FastifyInstance;

beforeAll(async () => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({}));
  app = await construirApp(env(), { telemetria });
});

afterAll(async () => {
  await app.close();
  await telemetria.encerrar();
});

describe('/metrics no openapi.yaml', () => {
  it('está documentado com 200 e 404', () => {
    const bloco = blocoDeMetrics();

    expect(bloco).toContain("'200':");
    expect(bloco).toContain("'404':");
  });

  it('declara text/plain no 200 e problem+json no 404', () => {
    const bloco = blocoDeMetrics();

    expect(bloco).toContain('text/plain');
    expect(bloco).toContain('application/problem+json');
  });

  it('é declarado sem autenticação — o scraper raspa sem credencial', () => {
    expect(blocoDeMetrics()).toContain('security: []');
  });
});

describe('resposta real × contrato', () => {
  it('o 200 sai em text/plain, como o contrato declara', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/metrics' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.headers['content-type']).toContain('text/plain');
  });

  it('o 404 de métricas desligadas sai em problem+json, como o contrato declara', async () => {
    const desligada = iniciarTelemetria(esquemaTelemetria.parse({ METRICS_ENABLED: 'false' }));
    const semMetricas = await construirApp(env({ METRICS_ENABLED: 'false' }), {
      telemetria: desligada,
    });

    try {
      const resposta = await semMetricas.inject({ method: 'GET', url: '/metrics' });

      expect(resposta.statusCode).toBe(404);
      expect(resposta.headers['content-type']).toContain('application/problem+json');
      expect(resposta.json<{ type: string; status: number }>().status).toBe(404);
    } finally {
      await semMetricas.close();
      await desligada.encerrar();
    }
  });
});
