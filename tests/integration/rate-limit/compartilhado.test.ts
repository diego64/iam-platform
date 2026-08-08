/**
 * O teto vale para a plataforma, não para o processo.
 *
 * Duas instâncias do app apontando para o mesmo Mongo dividem a cota: cinco tentativas numa
 * e a sexta na outra já é barrada. Com o contador local do plugin — o comportamento de antes
 * desta SPEC — cada instância teria a própria contagem e a sexta passaria.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import { criarStoreDoPlugin } from '../../../src/shared/rate-limit/fastify-store.js';
import { criarContadorNoMongo } from '../../../src/shared/rate-limit/mongo-store.js';
import { criarContadorEmMemoria } from '../../../src/shared/rate-limit/memory-store.js';
import type { ContadorDeRateLimit } from '../../../src/shared/rate-limit/types.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const TETO = 5;

let mongo: MongoClient;
let banco: Db;
let instanciaA: FastifyInstance;
let instanciaB: FastifyInstance;

const ROTA_LIMITADA = '/teste/limitado';

/**
 * App mínimo com o plugin e o store compartilhado.
 *
 * Não passa pelo `construirApp` de propósito: o que este arquivo exercita é o adaptador
 * contra o contrato real do `@fastify/rate-limit`, e a fiação do app é coberta pela suíte
 * inteira continuar verde.
 */
async function montar(contador: ContadorDeRateLimit): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register((await import('@fastify/rate-limit')).default, {
    global: false,
    store: criarStoreDoPlugin({ contador, pepper: PEPPER }),
  });
  app.get(ROTA_LIMITADA, { config: { rateLimit: { max: TETO, timeWindow: '1 minute' } } }, () => ({
    ok: true,
  }));
  await app.ready();
  return app;
}

/** Sobe uma instância com o contador dado. */
async function subir(contador: ContadorDeRateLimit): Promise<FastifyInstance> {
  return montar(contador);
}

beforeAll(async () => {
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
});

afterAll(async () => {
  await instanciaA.close();
  await instanciaB.close();
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('rate_limit_counters').deleteMany({});
});

describe('contador compartilhado entre instâncias', () => {
  it('a cota gasta numa instância vale na outra', async () => {
    const contador = criarContadorNoMongo({ banco, timeoutMs: 500 });
    instanciaA = await subir(contador);
    instanciaB = await subir(contador);
    const origem = '10.60.0.1';

    for (let tentativa = 0; tentativa < TETO; tentativa += 1) {
      const res = await instanciaA.inject({
        method: 'GET',
        url: ROTA_LIMITADA,
        remoteAddress: origem,
      });
      expect(res.statusCode).toBe(200);
    }

    // A sexta chega na outra réplica — e ainda assim é barrada.
    const excedida = await instanciaB.inject({
      method: 'GET',
      url: ROTA_LIMITADA,
      remoteAddress: origem,
    });

    expect(excedida.statusCode).toBe(429);
    expect(excedida.headers['retry-after']).toBeDefined();
  });

  it('IPs diferentes não compartilham cota', async () => {
    const contador = criarContadorNoMongo({ banco, timeoutMs: 500 });
    const app = await subir(contador);

    for (let tentativa = 0; tentativa < TETO; tentativa += 1) {
      await app.inject({ method: 'GET', url: ROTA_LIMITADA, remoteAddress: '10.60.0.2' });
    }
    const outroIp = await app.inject({
      method: 'GET',
      url: ROTA_LIMITADA,
      remoteAddress: '10.60.0.3',
    });

    expect(outroIp.statusCode).toBe(200);
    await app.close();
  });

  it('nenhum IP em claro na coleção de contadores', async () => {
    const contador = criarContadorNoMongo({ banco, timeoutMs: 500 });
    const app = await subir(contador);

    await app.inject({ method: 'GET', url: ROTA_LIMITADA, remoteAddress: '10.60.0.44' });

    const documentos = await banco.collection('rate_limit_counters').find({}).toArray();
    expect(JSON.stringify(documentos)).not.toContain('10.60.0.44');
    await app.close();
  });

  it('com o contador em memória o app continua funcionando', async () => {
    // É o modo de desenvolvimento: correto num processo só.
    const app = await montar(criarContadorEmMemoria());

    const res = await app.inject({
      method: 'GET',
      url: ROTA_LIMITADA,
      remoteAddress: '10.60.0.5',
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('fail open na borda do plugin', () => {
  it('contador fora do ar deixa a requisição seguir', async () => {
    // Banco fechado: é o que acontece quando o Mongo cai no meio do tráfego.
    const { cliente: efemero, banco: bancoEfemero } = await conectarMongo(envDeIntegracao());
    await efemero.close();
    const app = await montar(criarContadorNoMongo({ banco: bancoEfemero, timeoutMs: 100 }));

    // Muito além do teto: sem contador, nada barra.
    for (let tentativa = 0; tentativa < TETO + 3; tentativa += 1) {
      const res = await app.inject({
        method: 'GET',
        url: ROTA_LIMITADA,
        remoteAddress: '10.60.0.6',
      });
      expect(res.statusCode).toBe(200);
    }

    await app.close();
  });
});
