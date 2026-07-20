/**
 * Regressão: `METRICS_ENABLED=false` precisa desligar TODA exportação de métrica, não só
 * a rota `/metrics`.
 *
 * O NodeSDK monta pipelines a partir do ambiente quando as listas não são passadas
 * explicitamente. Com métricas desligadas mas um endpoint OTLP presente (para traces), o
 * SDK caía no default e criava um exportador OTLP de métricas: o `/metrics` respondia 404,
 * o handle dizia `metricas: false`, e as séries eram empurradas ao Collector assim mesmo —
 * o vazamento silencioso que esta SPEC existe para evitar (RF-11, design §9).
 *
 * O sinal do vazamento aparece no flush do encerramento: o metric reader é periódico, e
 * `encerrar()` força a descarga. Um coletor HTTP local registra o que chegou.
 *
 * DETALHE que o primeiro esboço deste teste errou: o reader default do NodeSDK lê o
 * endpoint de `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`, não do objeto de config. Em
 * produção o container define essa variável, então o vazamento aponta para o Collector
 * real. Aqui ela precisa apontar para o coletor local, senão o vazamento vai para
 * localhost:4318 e o teste não vê nada — passando por reproduzir mal, não por estar são.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metrics } from '@opentelemetry/api';
import { esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';

/** Caminhos OTLP que o coletor viu chegar. */
const caminhosRecebidos: string[] = [];

let coletor: Server;
let telemetria: Telemetria;
let endpointOriginal: string | undefined;

function subirColetor(): Promise<Server> {
  return new Promise((resolver) => {
    const servidor = createServer((requisicao, resposta) => {
      caminhosRecebidos.push(requisicao.url ?? '');
      requisicao.on('data', () => undefined);
      requisicao.on('end', () => {
        resposta.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    servidor.listen(0, '127.0.0.1', () => {
      resolver(servidor);
    });
  });
}

beforeAll(async () => {
  coletor = await subirColetor();
  const endpoint = `http://127.0.0.1:${String((coletor.address() as AddressInfo).port)}`;

  // O reader default do NodeSDK lê ISTO, não o objeto de config abaixo. Apontar para o
  // coletor local é o que faz um eventual vazamento pousar onde o teste consegue vê-lo.
  endpointOriginal = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;

  // O cenário do vazamento: métricas desligadas, mas há endpoint OTLP porque os traces
  // estão ligados. É a combinação que fazia o metric reader default subir sozinho.
  telemetria = iniciarTelemetria(
    esquemaTelemetria.parse({
      METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_TRACES_SAMPLER_ARG: '1',
    }),
  );

  // Cria e mexe numa métrica: se algum reader estiver escutando, o flush a exportaria.
  metrics.getMeter('regressao').createCounter('iam_nao_deve_vazar').add(1);

  // Força a descarga de tudo que estiver em buffer — é aqui que o vazamento apareceria.
  await telemetria.encerrar();
});

afterAll(async () => {
  if (endpointOriginal === undefined) {
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  } else {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpointOriginal;
  }
  await new Promise<void>((resolver) => {
    coletor.close(() => {
      resolver();
    });
  });
});

describe('METRICS_ENABLED=false com endpoint OTLP presente', () => {
  it('o handle reporta métricas desligadas e sem exportador', () => {
    expect(telemetria.metricas).toBe(false);
    expect(telemetria.exportadorPrometheus).toBeUndefined();
    // Traces seguem ligados: o endpoint OTLP existe.
    expect(telemetria.traces).toBe(true);
  });

  it('nenhuma métrica é empurrada por OTLP', () => {
    const metricasEnviadas = caminhosRecebidos.filter((caminho) => caminho.includes('/v1/metrics'));

    expect(metricasEnviadas).toEqual([]);
  });
});
