/**
 * Cobre o store compartilhado atrás do `@fastify/rate-limit`.
 *
 * O caso que motivou este arquivo: a chave era derivada só do IP e `child()` devolvia `this`,
 * então todas as rotas dividiam um balde só. Três chamadas de uma rota de teto 3 barravam o
 * login, que tem teto 5, e a janela era a de quem criasse a chave primeiro — o limite
 * documentado por rota não descrevia o que acontecia em produção.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { criarStoreDoPlugin } from '../../../../src/shared/rate-limit/fastify-store.js';
import { criarContadorEmMemoria } from '../../../../src/shared/rate-limit/memory-store.js';
import type { ContadorDeRateLimit } from '../../../../src/shared/rate-limit/types.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const IP = '203.0.113.10';

type Rota = { url: string; max: number; timeWindow?: string };

async function montar(
  rotas: readonly Rota[],
  contador: ContadorDeRateLimit = criarContadorEmMemoria(),
  aoFalhar?: () => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, {
    global: false,
    store: criarStoreDoPlugin({
      contador,
      pepper: PEPPER,
      ...(aoFalhar === undefined ? {} : { aoFalhar }),
    }),
  });

  for (const rota of rotas) {
    app.post(
      rota.url,
      { config: { rateLimit: { max: rota.max, timeWindow: rota.timeWindow ?? '1 minute' } } },
      () => ({ ok: true }),
    );
  }

  await app.ready();
  return app;
}

type Resposta = Awaited<ReturnType<FastifyInstance['inject']>>;

async function bater(app: FastifyInstance, url: string): Promise<Resposta> {
  return app.inject({ method: 'POST', url, remoteAddress: IP });
}

describe('isolamento entre rotas', () => {
  it('gastar a cota de uma rota não consome a de outra', async () => {
    const app = await montar([
      { url: '/login', max: 5 },
      { url: '/teste', max: 3 },
    ]);

    const login = [
      await bater(app, '/login'),
      await bater(app, '/login'),
      await bater(app, '/login'),
    ];
    const teste = await bater(app, '/teste');

    expect(login.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    // A primeira requisição de `/teste` precisa passar. Com balde único ela vinha 429,
    // porque as três de `/login` já tinham enchido o teto 3 dela.
    expect(teste.statusCode).toBe(200);
    await app.close();
  });

  it('cada rota barra no próprio teto', async () => {
    const app = await montar([
      { url: '/login', max: 5 },
      { url: '/teste', max: 3 },
    ]);

    for (let i = 0; i < 3; i += 1) await bater(app, '/teste');
    const quartaDoTeste = await bater(app, '/teste');

    for (let i = 0; i < 5; i += 1) await bater(app, '/login');
    const sextaDoLogin = await bater(app, '/login');

    expect(quartaDoTeste.statusCode).toBe(429);
    expect(sextaDoLogin.statusCode).toBe(429);
    await app.close();
  });

  it('cada rota anuncia a própria janela', async () => {
    const app = await montar([
      { url: '/longa', max: 50, timeWindow: '1 hour' },
      { url: '/curta', max: 50, timeWindow: '1 minute' },
    ]);

    const longa = await bater(app, '/longa');
    const curta = await bater(app, '/curta');

    // Antes, `/curta` herdava a hora de quem tivesse criado a chave primeiro, porque o
    // contador fixa `expires_at` na criação e a chave era a mesma.
    expect(String(longa.headers['x-ratelimit-reset'])).toBe('3600');
    expect(String(curta.headers['x-ratelimit-reset'])).toBe('60');
    await app.close();
  });

  it('o mesmo caminho em métodos diferentes são rotas diferentes', async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyRateLimit, {
      global: false,
      store: criarStoreDoPlugin({ contador: criarContadorEmMemoria(), pepper: PEPPER }),
    });
    const limite = { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } };
    app.get('/recurso', limite, () => ({ ok: true }));
    app.post('/recurso', limite, () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/recurso', remoteAddress: IP });
    const post = await app.inject({ method: 'POST', url: '/recurso', remoteAddress: IP });

    expect(post.statusCode).toBe(200);
    await app.close();
  });

  it('IPs diferentes continuam separados dentro da mesma rota', async () => {
    const app = await montar([{ url: '/login', max: 1 }]);

    await app.inject({ method: 'POST', url: '/login', remoteAddress: '203.0.113.10' });
    const outro = await app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '203.0.113.11',
    });

    expect(outro.statusCode).toBe(200);
    await app.close();
  });
});

describe('o que não pode mudar', () => {
  it('o identificador não chega em claro ao contador', async () => {
    const chaves: string[] = [];
    const espiao: ContadorDeRateLimit = {
      incrementar: (chave) => {
        chaves.push(chave);
        return Promise.resolve({ contagem: 1, expiraEm: new Date(Date.now() + 60_000) });
      },
      ler: () => Promise.resolve(null),
    };

    const app = await montar([{ url: '/login', max: 5 }], espiao);
    await bater(app, '/login');

    expect(chaves[0]).not.toContain(IP);
    expect(chaves[0]).not.toContain('/login');
    // O prefixo legível continua sendo a dimensão, para depurar a coleção sem devolver
    // nada sobre quem é o dono da contagem.
    expect(chaves[0]).toMatch(/^ip:[0-9a-f]{64}$/);
    await app.close();
  });

  it('contador fora do ar deixa a requisição passar', async () => {
    let falhas = 0;
    const quebrado: ContadorDeRateLimit = {
      incrementar: () => Promise.resolve(null),
      ler: () => Promise.resolve(null),
    };

    const app = await montar([{ url: '/login', max: 1 }], quebrado, () => {
      falhas += 1;
    });

    const respostas = [await bater(app, '/login'), await bater(app, '/login')];

    // Fail open: negar quando o contador está fora transformaria queda do banco em queda
    // do login.
    expect(respostas.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(falhas).toBeGreaterThan(0);
    await app.close();
  });

  it('contador que lança tem o mesmo efeito de contador fora', async () => {
    const explosivo: ContadorDeRateLimit = {
      incrementar: () => Promise.reject(new Error('mongo fora')),
      ler: () => Promise.reject(new Error('mongo fora')),
    };

    const app = await montar([{ url: '/login', max: 1 }], explosivo);

    expect((await bater(app, '/login')).statusCode).toBe(200);
    await app.close();
  });
});
