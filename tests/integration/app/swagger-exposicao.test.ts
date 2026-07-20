/**
 * Garante que a UI do Swagger não é servida em produção, e que o documento OpenAPI
 * em memória continua disponível em todo ambiente (o teste de contrato depende dele).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv } from '../../../src/config/env.js';

function envCom(ambiente: string): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: ambiente,
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
  });
}

let appProducao: FastifyInstance;
let appDesenvolvimento: FastifyInstance;

beforeAll(async () => {
  appProducao = await construirApp(envCom('production'));
  appDesenvolvimento = await construirApp(envCom('development'));
});

afterAll(async () => {
  await appProducao.close();
  await appDesenvolvimento.close();
});

describe('exposição do Swagger em produção', () => {
  it('não serve a UI em /docs', async () => {
    const resposta = await appProducao.inject({ method: 'GET', url: '/docs' });

    expect(resposta.statusCode).toBe(404);
  });

  it('não serve o documento em /docs/json', async () => {
    const resposta = await appProducao.inject({ method: 'GET', url: '/docs/json' });

    expect(resposta.statusCode).toBe(404);
  });

  it('responde o 404 em problem+json, como qualquer outra rota inexistente', async () => {
    const resposta = await appProducao.inject({ method: 'GET', url: '/docs' });

    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });

  it('mantém o documento OpenAPI em memória para o teste de contrato', () => {
    const documento = appProducao.swagger() as { paths: Record<string, unknown> };

    expect(documento.paths).toHaveProperty('/health/live');
  });

  it('segue servindo /health/live normalmente', async () => {
    const resposta = await appProducao.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('exposição do Swagger fora de produção', () => {
  it('serve a UI em /docs', async () => {
    const resposta = await appDesenvolvimento.inject({ method: 'GET', url: '/docs' });

    expect([200, 302]).toContain(resposta.statusCode);
  });

  it('serve o documento em /docs/json', async () => {
    const resposta = await appDesenvolvimento.inject({ method: 'GET', url: '/docs/json' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json<{ paths: object }>().paths).toHaveProperty('/health/live');
  });
});
