/**
 * Collector fora não pode virar incidente.
 *
 * Telemetria é diagnóstico, não função: derrubar — ou sequer atrasar — o serviço porque
 * o coletor caiu inverte a prioridade e transforma a ferramenta de investigação na causa
 * raiz. Aqui o endpoint OTLP aponta para uma porta morta durante o teste inteiro.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv, esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { criarLogger } from '../../../src/shared/logger/index.js';

/** Porta 1 nunca tem coletor escutando — é o "Collector fora" deste teste. */
const COLETOR_MORTO = 'http://127.0.0.1:1';

const REQUISICOES = 200;

function env(sobrescritas: Record<string, string> = {}): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    ...sobrescritas,
  });
}

let telemetria: Telemetria;
let comColetorMorto: FastifyInstance;
let semTelemetria: FastifyInstance;
const linhasDeLog: Record<string, unknown>[] = [];

beforeAll(async () => {
  const destino = new Writable({
    write(pedaco: Buffer, _codificacao, prosseguir): void {
      linhasDeLog.push(JSON.parse(pedaco.toString()) as Record<string, unknown>);
      prosseguir();
    },
  });

  telemetria = iniciarTelemetria(
    esquemaTelemetria.parse({
      OTEL_EXPORTER_OTLP_ENDPOINT: COLETOR_MORTO,
      OTEL_TRACES_SAMPLER_ARG: '1',
    }),
    criarLogger({ nivel: 'warn', destino }),
  );

  comColetorMorto = await construirApp(env(), { telemetria });
  semTelemetria = await construirApp(env());
});

afterAll(async () => {
  await comColetorMorto.close();
  await semTelemetria.close();
  await telemetria.encerrar();
});

/** Mediana das durações, em milissegundos. */
async function medianaDeLatencia(app: FastifyInstance): Promise<number> {
  const duracoes: number[] = [];

  for (let n = 0; n < REQUISICOES; n += 1) {
    const inicio = performance.now();
    const resposta = await app.inject({ method: 'GET', url: '/health/live' });
    duracoes.push(performance.now() - inicio);

    expect(resposta.statusCode).toBe(200);
  }

  duracoes.sort((a, b) => a - b);
  return duracoes[Math.floor(duracoes.length / 2)] ?? 0;
}

describe('Collector inalcançável', () => {
  it('a aplicação responde normalmente', async () => {
    for (let n = 0; n < 50; n += 1) {
      const resposta = await comColetorMorto.inject({ method: 'GET', url: '/health/live' });

      expect(resposta.statusCode).toBe(200);
      expect(resposta.json<{ status: string }>().status).toBe('ok');
    }
  });

  it('nenhum erro chega ao cliente por causa da exportação', async () => {
    const resposta = await comColetorMorto.inject({ method: 'GET', url: '/rota/inexistente' });

    // 404 do handler padrão, não 500: a falha de exportação acontece fora do caminho da
    // requisição e não pode contaminar a resposta.
    expect(resposta.statusCode).toBe(404);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });

  it('a latência não sobe acima de 5 ms sobre a linha de base', async () => {
    const linhaDeBase = await medianaDeLatencia(semTelemetria);
    const comColetorFora = await medianaDeLatencia(comColetorMorto);

    expect(comColetorFora - linhaDeBase).toBeLessThan(5);
  });

  it('a falha de exportação é logada de forma agregada, nunca por span', () => {
    // Uma linha por span geraria milhares de entradas idênticas e enterraria o resto do
    // log justamente durante o incidente. O agregador emite no máximo uma por janela, e
    // esta suíte é curta demais para fechar uma janela inteira.
    const falhas = linhasDeLog.filter((linha) => linha.msg === 'telemetria.exportacao_falhou');

    expect(falhas.length).toBeLessThanOrEqual(1);
  });
});
