/**
 * Confere que os instrumentos de clientes aparecem na exposição do Prometheus depois de
 * registrados, e que nenhuma série carrega o identificador do cliente como rótulo — o
 * número de clientes é justamente o que cresce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { criarMedidorDeClientes } from '../../../src/modules/api-clients/index.js';

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

  const medidor = criarMedidorDeClientes();
  medidor.contarFalhaDeAutenticacao('unknown_client');
  medidor.contarFalhaDeAutenticacao('expired_previous');
  medidor.contarSucessoDeAutenticacao();
  medidor.registrarContagem({ active: 3, disabled: 1, deleted: 2 });
  medidor.contarCriacao();
  medidor.contarRotacaoDeSegredo();
});

afterAll(async () => {
  await app.close();
  await telemetria.encerrar();
});

describe('métricas de clientes em /metrics', () => {
  it('publica falhas, sucessos, contagem por estado e operações administrativas', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(corpo).toContain('iam_client_auth_failures_total');
    expect(corpo).toContain('iam_client_auth_success_total');
    expect(corpo).toContain('iam_api_clients');
    expect(corpo).toContain('iam_api_clients_admin_total');
  });

  it('rotula a falha pelo motivo e a contagem pelo estado', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(corpo).toMatch(/iam_client_auth_failures_total\{[^}]*motivo="unknown_client"/);
    expect(corpo).toMatch(/iam_client_auth_failures_total\{[^}]*motivo="expired_previous"/);
    expect(corpo).toMatch(/iam_api_clients\{[^}]*status="disabled"[^}]*\} 1/);
  });

  it('rotula a operação administrativa', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(corpo).toMatch(/iam_api_clients_admin_total\{[^}]*operacao="create"/);
    expect(corpo).toMatch(/iam_api_clients_admin_total\{[^}]*operacao="rotate_secret"/);
  });

  // Uma série por cliente cresceria sem teto: o número de clientes é o que aumenta.
  it('nenhuma série de cliente carrega o identificador como rótulo', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    const linhas = corpo
      .split('\n')
      .filter((l) => l.startsWith('iam_client_') || l.startsWith('iam_api_clients'));
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => !l.includes('client_id'))).toBe(true);
    expect(linhas.every((l) => !l.includes('cli_'))).toBe(true);
  });
});
