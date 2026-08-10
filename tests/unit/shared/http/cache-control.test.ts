/**
 * Cobre os três ramos da decisão de cache num app mínimo: default sem armazenamento, rota
 * declarada como cacheável e handler que já decidiu por conta própria.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registrarControleDeCache } from '../../../../src/shared/http/cache-control.js';

let app: FastifyInstance;

/** App mínimo com o gancho e as rotas que cada caso precisa. */
async function montar(): Promise<FastifyInstance> {
  const instancia = Fastify({ logger: false });
  registrarControleDeCache(instancia);

  instancia.get('/auth/me', () => ({ id: 'u1' }));
  instancia.get('/.well-known/jwks.json', () => ({ keys: [] }));
  instancia.get('/.well-known/security.txt', () => 'Contact: x');
  // Rota futura sob o mesmo prefixo, para provar que o casamento é por caminho exato.
  instancia.get('/.well-known/algo-novo', () => ({}));
  instancia.get('/decide-sozinho', (_requisicao, resposta) =>
    resposta.header('cache-control', 'public, max-age=42').send({ ok: true }),
  );

  await instancia.ready();
  return instancia;
}

afterEach(async () => {
  await app.close();
});

describe('default sem armazenamento', () => {
  it('aplica a diretiva completa a uma rota não declarada', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(resposta.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(resposta.headers['pragma']).toBe('no-cache');
  });

  it('vale para o 404, que não passa por handler de rota', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/rota-inexistente' });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
  });
});

describe('rotas declaradas como cacheáveis', () => {
  it('deixa a chave pública ser guardada por cinco minutos', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });

    expect(resposta.headers['cache-control']).toBe('public, max-age=300');
  });

  it('não acrescenta a diretiva de HTTP/1.0 onde o cache é permitido', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });

    expect(resposta.headers['pragma']).toBeUndefined();
  });

  it('casa por caminho exato, não por prefixo', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/.well-known/algo-novo' });

    expect(resposta.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
  });
});

describe('handler que já decidiu', () => {
  it('não é sobrescrito pelo gancho', async () => {
    app = await montar();

    const resposta = await app.inject({ method: 'GET', url: '/decide-sozinho' });

    expect(resposta.headers['cache-control']).toBe('public, max-age=42');
  });
});
