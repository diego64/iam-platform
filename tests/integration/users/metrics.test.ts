/**
 * Confere que os contadores de usuário aparecem na exposição do Prometheus depois de
 * registrados. Usa o app real com telemetria ligada; o medidor grava no meter do OTel, que
 * o exportador do `/metrics` publica.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { criarMedidorDeUsuarios } from '../../../src/modules/users/metrics/users.metrics.js';

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

  // Registra os contadores no meter global e grava uma amostra de cada operação.
  const medidor = criarMedidorDeUsuarios();
  medidor.contarCriacao();
  medidor.contarBloqueio('ok');
  medidor.contarRemocao();
});

afterAll(async () => {
  await app.close();
  await telemetria.encerrar();
});

describe('métricas de usuário em /metrics', () => {
  it('publica iam_users_created/blocked/deleted', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(corpo).toContain('iam_users_created_total');
    expect(corpo).toContain('iam_users_blocked_total');
    expect(corpo).toContain('iam_users_deleted_total');
    // O rótulo fechado `resultado` viaja no bloqueio.
    expect(corpo).toMatch(/iam_users_blocked_total\{[^}]*resultado="ok"/);
  });
});
