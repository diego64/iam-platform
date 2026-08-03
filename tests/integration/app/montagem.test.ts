/**
 * Cobre o que o app real serve e como ele responde na borda: plugins de segurança,
 * política de CORS e a superfície de rotas com e sem os módulos injetados.
 *
 * Sem banco: nenhum caso aqui chega a um handler que consulte PostgreSQL ou Mongo — o que
 * se prova é a montagem, não o comportamento de cada rota.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, type Env } from '../../../src/config/env.js';

const ORIGEM_LIBERADA = 'https://app.exemplo.com';
const ORIGEM_ESTRANHA = 'https://invasor.exemplo.com';

function envDeTeste(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    ...sobrescritas,
  });
}

let appFechado: FastifyInstance;
let appAberto: FastifyInstance;

beforeAll(async () => {
  appFechado = await construirApp(envDeTeste());
  appAberto = await construirApp(envDeTeste({ CORS_ALLOWED_ORIGINS: ORIGEM_LIBERADA }));
});

afterAll(async () => {
  await appFechado.close();
  await appAberto.close();
});

describe('cabeçalhos de segurança', () => {
  it('toda resposta traz os cabeçalhos do helmet', async () => {
    const resposta = await appFechado.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    expect(resposta.headers['x-frame-options']).toBeDefined();
    expect(resposta.headers['content-security-policy']).toBeDefined();
  });

  it('o 404 também passa pelos plugins de borda', async () => {
    const resposta = await appFechado.inject({ method: 'GET', url: '/rota-que-nao-existe' });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('política de CORS', () => {
  it('sem lista configurada, nenhuma origem é liberada', async () => {
    const resposta = await appFechado.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: ORIGEM_ESTRANHA },
    });

    expect(resposta.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('origem da lista recebe a liberação', async () => {
    const resposta = await appAberto.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: ORIGEM_LIBERADA },
    });

    expect(resposta.headers['access-control-allow-origin']).toBe(ORIGEM_LIBERADA);
  });

  it('origem fora da lista não recebe liberação, mesmo com a lista configurada', async () => {
    const resposta = await appAberto.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: ORIGEM_ESTRANHA },
    });

    expect(resposta.headers['access-control-allow-origin']).toBeUndefined();
  });
});
