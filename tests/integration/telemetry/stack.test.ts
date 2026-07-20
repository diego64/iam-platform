/**
 * Integração com a stack de observabilidade real: Collector, Prometheus e Tempo.
 *
 * Exige `pnpm infra:monitoring`. Sem a stack no ar, os casos são pulados com motivo
 * explícito — nunca reportados como sucesso. Um teste de observabilidade que "passa" sem
 * coletor é exatamente o tipo de verde que esconde ausência de dado, que é o problema
 * que esta SPEC existe para resolver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';

const COLLECTOR = 'http://127.0.0.1:4318';
const PROMETHEUS = 'http://127.0.0.1:9090';
const TEMPO = 'http://127.0.0.1:3200';

/** Alcançável em poucos segundos? Serve para decidir entre rodar e pular. */
async function noAr(url: string): Promise<boolean> {
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return resposta.ok || resposta.status < 500;
  } catch {
    return false;
  }
}

const stackNoAr =
  (await noAr(`${PROMETHEUS}/-/ready`)) &&
  (await noAr(`${TEMPO}/ready`)) &&
  (await noAr(`${COLLECTOR}/v1/traces`));

const comStack = stackNoAr ? describe : describe.skip;

let telemetria: Telemetria | undefined;
let app: FastifyInstance | undefined;
let traceIdGerado = '';

beforeAll(async () => {
  if (!stackNoAr) return;

  telemetria = iniciarTelemetria(
    esquemaTelemetria.parse({
      OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
      OTEL_TRACES_SAMPLER_ARG: '1',
      OTEL_SERVICE_NAME: 'iam-platform-teste',
    }),
  );

  // Depois do SDK, sempre: import estático seria içado para antes e a instrumentação
  // não teria o que envolver.
  const { default: Fastify } = await import('fastify');
  const { trace } = await import('@opentelemetry/api');

  app = Fastify({ logger: false });
  app.get('/instrumentada', () => {
    traceIdGerado = trace.getActiveSpan()?.spanContext().traceId ?? '';
    return { ok: true };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const porta = (app.server.address() as AddressInfo).port;
  await fetch(`http://127.0.0.1:${String(porta)}/instrumentada`);

  // Encerrar descarrega o buffer: sem isso a asserção correria contra o lote.
  await telemetria.encerrar();
}, 30_000);

afterAll(async () => {
  await app?.close();
});

comStack('stack de observabilidade no ar', () => {
  it('o Prometheus está com o alvo do serviço configurado', async () => {
    const resposta = await fetch(`${PROMETHEUS}/api/v1/targets`);
    const corpo = (await resposta.json()) as {
      data: { activeTargets: { scrapePool: string; lastError: string }[] };
    };

    const nosso = corpo.data.activeTargets.filter((alvo) => alvo.scrapePool === 'iam-platform');

    // Verifica a configuração do alvo, não o resultado da raspagem: o alvo aponta para a
    // porta 3000 do host, e este teste sobe o app numa porta efêmera. Que o endpoint
    // responde em formato válido é o que tests/integration/metrics/ cobre; aqui o que
    // importa é que o Prometheus do compose sabe onde procurar.
    expect(nosso.length).toBeGreaterThan(0);
  });

  it('a requisição instrumentada gera um trace com id válido', () => {
    expect(traceIdGerado).toMatch(/^[0-9a-f]{32}$/);
  });

  it('o trace chega ao Tempo', async () => {
    // O Tempo ingere de forma assíncrona; algumas tentativas cobrem a janela sem
    // transformar o teste num sleep fixo.
    let encontrado = false;

    for (let tentativa = 0; tentativa < 10 && !encontrado; tentativa += 1) {
      const resposta = await fetch(`${TEMPO}/api/traces/${traceIdGerado}`);
      encontrado = resposta.status === 200;
      if (!encontrado) await new Promise((resolver) => setTimeout(resolver, 1_000));
    }

    expect(encontrado).toBe(true);
  }, 20_000);
});

describe('pré-requisito da suíte', () => {
  it.skipIf(stackNoAr)(
    'a stack de observabilidade não está no ar — rode pnpm infra:monitoring',
    () => {
      // Este caso existe para a ausência aparecer no relatório em vez de sumir. Um teste
      // de observabilidade pulado em silêncio é indistinguível de um que passou.
      expect(stackNoAr).toBe(false);
    },
  );
});
