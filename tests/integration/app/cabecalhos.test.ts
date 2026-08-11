/**
 * Cobre os cabeçalhos de segurança como eles saem do app real, em cada classe de resposta.
 *
 * O teste unitário prova o que a política **declara**; este prova o que chega ao cliente —
 * incluindo nos caminhos que não passam por handler de rota nenhum (404, erro de framework),
 * onde é fácil um cabeçalho sumir sem ninguém notar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, type Env } from '../../../src/config/env.js';
import { montarAppCompleto } from '../../mocks/app-completo.js';

function envDeTeste(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    ...sobrescritas,
  });
}

let app: FastifyInstance;
let appCompleto: FastifyInstance;

beforeAll(async () => {
  app = await construirApp(envDeTeste());
  appCompleto = await montarAppCompleto();
});

afterAll(async () => {
  await app.close();
  await appCompleto.close();
});

describe('política de conteúdo', () => {
  it('nega tudo nas rotas de API', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });
    const politica = resposta.headers['content-security-policy'];

    expect(politica).toContain("default-src 'none'");
    expect(politica).toContain("frame-ancestors 'none'");
    expect(politica).toContain("base-uri 'none'");
    expect(politica).toContain("form-action 'none'");
    expect(politica).toContain('sandbox');
  });

  it('não libera script — nem inline nem da própria origem', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(resposta.headers['content-security-policy']).not.toContain('script-src');
  });
});

describe('conjunto transversal', () => {
  const esperado: ReadonlyArray<readonly [string, string]> = [
    ['x-frame-options', 'DENY'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
    ['cross-origin-resource-policy', 'same-origin'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['x-permitted-cross-domain-policies', 'none'],
  ];

  it.each(esperado)('%s = %s numa resposta de sucesso', async (cabecalho, valor) => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });

    expect(resposta.headers[cabecalho]).toBe(valor);
  });

  it('vale também no 404, que não passa por handler de rota', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/nao-existe' });

    expect(resposta.statusCode).toBe(404);
    for (const [cabecalho, valor] of esperado) {
      expect(resposta.headers[cabecalho]).toBe(valor);
    }
  });

  it('vale numa rota autenticada respondendo 401', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/auth/me' });

    expect(resposta.statusCode).toBe(401);
    for (const [cabecalho, valor] of esperado) {
      expect(resposta.headers[cabecalho]).toBe(valor);
    }
  });

  it('vale no erro emitido antes de haver rota', async () => {
    const resposta = await appCompleto.inject({
      method: 'GET',
      url: `/users/${'x'.repeat(300)}`,
    });

    expect(resposta.statusCode).toBe(414);
    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('transporte estrito', () => {
  it('anuncia pelo menos um ano, com subdomínios e sem pré-carga', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });
    const hsts = resposta.headers['strict-transport-security'];

    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).not.toContain('preload');
  });
});

describe('diretiva de cache', () => {
  it('nenhuma resposta de credencial é guardável', async () => {
    const resposta = await appCompleto.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@b.com', senha: 'S3nh@Forte!' },
    });

    expect(resposta.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(resposta.headers['pragma']).toBe('no-cache');
  });

  it('o perfil autenticado também não é guardável', async () => {
    const resposta = await appCompleto.inject({ method: 'GET', url: '/auth/me' });

    expect(resposta.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
  });

  it('a chave pública continua cacheável — o gancho não sobrescreve quem já decidiu', async () => {
    const resposta = await appCompleto.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    expect(resposta.headers['cache-control']).toBe('public, max-age=300');
  });

  it('o endpoint de token mantém o formato exigido pelo protocolo', async () => {
    const resposta = await appCompleto.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: 'grant_type=client_credentials',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(resposta.headers['cache-control']).toContain('no-store');
    expect(resposta.headers['pragma']).toBe('no-cache');
  });
});

describe('escopo da documentação', () => {
  it('relaxa a política só em /docs, e não nas rotas de API da mesma instância', async () => {
    const dev = await construirApp(envDeTeste({ NODE_ENV: 'development' }));

    try {
      const docs = await dev.inject({ method: 'GET', url: '/docs' });
      const api = await dev.inject({ method: 'GET', url: '/health/live' });

      expect(docs.headers['content-security-policy']).toContain("default-src 'self'");
      expect(api.headers['content-security-policy']).toContain("default-src 'none'");
    } finally {
      await dev.close();
    }
  });

  it('a documentação não sobe em produção', async () => {
    const prod = await construirApp(envDeTeste({ NODE_ENV: 'production' }));

    try {
      const resposta = await prod.inject({ method: 'GET', url: '/docs' });

      expect(resposta.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
