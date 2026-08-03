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
import { montarAppCompleto } from '../../mocks/app-completo.js';

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
let appCompleto: FastifyInstance;

beforeAll(async () => {
  appFechado = await construirApp(envDeTeste());
  appAberto = await construirApp(envDeTeste({ CORS_ALLOWED_ORIGINS: ORIGEM_LIBERADA }));
  appCompleto = await montarAppCompleto();
});

afterAll(async () => {
  await appFechado.close();
  await appAberto.close();
  await appCompleto.close();
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

describe('app sem módulos injetados', () => {
  it('serve apenas o que não depende de banco', () => {
    expect(appFechado.hasRoute({ method: 'GET', url: '/health/live' })).toBe(true);
    expect(appFechado.hasRoute({ method: 'GET', url: '/health/ready' })).toBe(true);
  });

  it('não registra as rotas dos módulos', () => {
    expect(appFechado.hasRoute({ method: 'POST', url: '/auth/login' })).toBe(false);
    expect(appFechado.hasRoute({ method: 'GET', url: '/users' })).toBe(false);
  });

  it('rota de módulo ausente responde 404 em problem+json', async () => {
    const resposta = await appFechado.inject({ method: 'POST', url: '/auth/login' });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });
});

describe('app com os módulos de autenticação, refresh e senha', () => {
  it.each([
    ['POST', '/auth/login'],
    ['POST', '/auth/logout'],
    ['GET', '/auth/me'],
    ['POST', '/auth/refresh'],
    ['POST', '/auth/password/change'],
    ['POST', '/auth/password/forgot'],
    ['POST', '/auth/password/reset'],
    ['GET', '/auth/password/policy'],
  ] as const)('registra %s %s', (metodo, caminho) => {
    expect(appCompleto.hasRoute({ method: metodo, url: caminho })).toBe(true);
  });

  // O teto por rota só existe porque o plugin foi registrado antes das rotas; sem ele
  // nenhuma destas subiria, e a montagem inteira falharia no boot.
  it('as rotas com teto declarado subiram', () => {
    expect(appCompleto.hasRoute({ method: 'POST', url: '/auth/login' })).toBe(true);
    expect(appCompleto.hasRoute({ method: 'POST', url: '/auth/password/change' })).toBe(true);
  });

  it('a troca de senha exige token — sem Bearer responde 401, não 500', async () => {
    const resposta = await appCompleto.inject({
      method: 'POST',
      url: '/auth/password/change',
      payload: { senha_atual: 'Senha-Antiga-1!', senha_nova: 'Senha-Muito-Longa-1!' },
    });

    expect(resposta.statusCode).toBe(401);
  });

  // Quem esqueceu a senha não tem token: fechar a rota atrás do verificador tornaria o
  // fluxo de recuperação inalcançável justamente para quem precisa dele.
  it('a política de senha continua pública', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/auth/password/policy' });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('app com os módulos de usuários, RBAC e ABAC', () => {
  it.each([
    ['POST', '/users'],
    ['GET', '/users'],
    ['GET', '/users/:id'],
    ['PATCH', '/users/:id'],
    ['DELETE', '/users/:id'],
    ['POST', '/users/:id/block'],
    ['POST', '/users/:id/unblock'],
    ['POST', '/roles'],
    ['GET', '/roles'],
    ['GET', '/roles/:id'],
    ['PATCH', '/roles/:id'],
    ['DELETE', '/roles/:id'],
    ['POST', '/roles/:id/permissions'],
    ['DELETE', '/roles/:id/permissions/:permId'],
    ['POST', '/permissions'],
    ['GET', '/permissions'],
    ['DELETE', '/permissions/:id'],
    ['GET', '/users/:id/roles'],
    ['POST', '/users/:id/roles'],
    ['DELETE', '/users/:id/roles/:roleId'],
    ['POST', '/policies'],
    ['GET', '/policies'],
    ['GET', '/policies/:id'],
    ['PATCH', '/policies/:id'],
    ['DELETE', '/policies/:id'],
    ['POST', '/policies/evaluate'],
  ] as const)('registra %s %s', (metodo, caminho) => {
    expect(appCompleto.hasRoute({ method: metodo, url: caminho })).toBe(true);
  });

  // O autorizador do módulo de usuário lê `requisicao.usuario`, que só existe depois do
  // verificador. Sem o hook do escopo, ele recusaria tudo por falta de token — e um 401
  // aqui é a prova de que o verificador rodou, não de que ninguém checou nada.
  it('rota administrativa de usuário sem Bearer responde 401', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/users' });

    expect(resposta.statusCode).toBe(401);
  });

  it('rota de RBAC sem Bearer responde 401', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/roles' });

    expect(resposta.statusCode).toBe(401);
  });

  it('rota de ABAC sem Bearer responde 401', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/policies' });

    expect(resposta.statusCode).toBe(401);
  });
});
