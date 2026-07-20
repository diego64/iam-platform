/**
 * Cobre a proteção de `/metrics` em produção e a raspagem pela stack real.
 *
 * O endpoint publica topologia, nomes de rota e volume de tráfego. No Render o serviço só
 * tem endereço público, então "rede interna" não é uma garantia da plataforma — a decisão
 * de abrir precisa estar registrada na configuração, e o default precisa ser fechado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../src/telemetry/sdk.js';

function env(sobrescritas: Record<string, string> = {}): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: 'production',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    ...sobrescritas,
  });
}

let telemetria: Telemetria;
let emProducao: FastifyInstance;
let liberado: FastifyInstance;

beforeAll(async () => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({}));
  emProducao = await construirApp(env({ METRICS_PUBLIC: 'false' }), { telemetria });
  liberado = await construirApp(env({ METRICS_PUBLIC: 'true' }), { telemetria });
});

afterAll(async () => {
  await emProducao.close();
  await liberado.close();
  await telemetria.encerrar();
});

describe('NODE_ENV=production e METRICS_PUBLIC=false', () => {
  it('recusa requisição vinda da internet', async () => {
    const resposta = await emProducao.inject({
      method: 'GET',
      url: '/metrics',
      // No Render, todo tráfego externo entra por um proxy que acrescenta este cabeçalho.
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });

  it('responde 404, não 403 — um 403 confirmaria que o endpoint existe', async () => {
    const resposta = await emProducao.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(resposta.statusCode).not.toBe(403);
    expect(resposta.body).not.toContain('iam_build_info');
  });

  it('atende a raspagem que chega pela rede interna', async () => {
    const resposta = await emProducao.inject({ method: 'GET', url: '/metrics' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.body).toContain('iam_build_info');
  });
});

describe('METRICS_PUBLIC=true — liberação por decisão explícita', () => {
  it('atende mesmo vindo da internet', async () => {
    const resposta = await liberado.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('fora de produção', () => {
  it('não restringe — o desenvolvimento não tem proxy na frente', async () => {
    const local = await construirApp(env({ NODE_ENV: 'development' }), { telemetria });

    try {
      const resposta = await local.inject({
        method: 'GET',
        url: '/metrics',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });

      expect(resposta.statusCode).toBe(200);
    } finally {
      await local.close();
    }
  });
});
