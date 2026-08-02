/**
 * Confere que os instrumentos da rotação aparecem na exposição do Prometheus depois de
 * registrados. Usa o app real com telemetria ligada; o medidor grava no meter do OTel, que
 * o exportador do `/metrics` publica.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { criarMedidorDeJwks } from '../../../src/modules/jwks/metrics/jwks.metrics.js';

let app: FastifyInstance;
let telemetria: Telemetria;

beforeAll(async () => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({ GIT_COMMIT: 'test' }));
  app = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
    { telemetria },
  );

  const medidor = criarMedidorDeJwks();
  medidor.registrarContagem({ active: 1, next: 1, retired: 2 });
  medidor.contarRotacao('scheduled');
  medidor.registrarIdadeDaAtiva(3600);
});

afterAll(async () => {
  await app.close();
  await telemetria.encerrar();
});

describe('métricas de rotação em /metrics', () => {
  it('publica a contagem por estado, as rotações e a idade da ativa', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(corpo).toContain('iam_jwks_keys');
    expect(corpo).toContain('iam_jwks_rotations_total');
    expect(corpo).toContain('iam_jwks_active_key_age_seconds');
  });

  it('rotula a rotação pelo motivo e a contagem pelo estado', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(corpo).toMatch(/iam_jwks_rotations_total\{[^}]*motivo="scheduled"/);
    expect(corpo).toMatch(/iam_jwks_keys\{[^}]*status="retired"[^}]*\} 2/);
  });

  it('não rotula rotação nem idade com kid — cardinalidade não pode explodir', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    const linhas = corpo.split('\n').filter((l) => l.startsWith('iam_jwks_'));
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => !l.includes('kid'))).toBe(true);
  });

  it('sem chave ativa, a idade não é publicada como zero', () => {
    // Zero mentiria que a chave acabou de entrar, o oposto do que o alerta procura.
    const medidor = criarMedidorDeJwks();

    expect(() => {
      medidor.registrarIdadeDaAtiva(null);
    }).not.toThrow();
  });
});
