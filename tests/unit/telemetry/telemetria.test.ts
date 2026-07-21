/**
 * Cobre o bootstrap do SDK: o que sobe, o que não sobe, e a garantia de que nenhum
 * caminho lança. Telemetria é diagnóstico — configuração ruim de coletor não pode
 * impedir o serviço de subir.
 *
 * Importa `sdk.js` e não `index.js` de propósito: o index sobe o SDK no import, e um
 * teste não deve herdar o singleton do processo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  iniciarTelemetria,
  versaoDaAplicacao,
  type Telemetria,
} from '../../../src/telemetry/sdk.js';
import { esquemaTelemetria, type ConfigDeTelemetria } from '../../../src/config/env.js';

function config(sobrescritas: Partial<Record<string, string>> = {}): ConfigDeTelemetria {
  return esquemaTelemetria.parse(sobrescritas);
}

const ligadas: Telemetria[] = [];

/** Sobe e registra para derrubar no fim — SDK deixado de pé vaza timer entre testes. */
function subir(sobrescritas: Partial<Record<string, string>> = {}): Telemetria {
  const telemetria = iniciarTelemetria(config(sobrescritas));
  ligadas.push(telemetria);
  return telemetria;
}

afterEach(async () => {
  await Promise.all(ligadas.splice(0).map((t) => t.encerrar()));
});

describe('iniciarTelemetria — o que sobe conforme a configuração', () => {
  it('sobe métricas por padrão, sem traces, porque não há endpoint OTLP', () => {
    const telemetria = subir();

    expect(telemetria.ativa).toBe(true);
    expect(telemetria.metricas).toBe(true);
    expect(telemetria.traces).toBe(false);
    expect(telemetria.exportadorPrometheus).toBeDefined();
  });

  it('sobe o pipeline de traces quando há endpoint OTLP', () => {
    const telemetria = subir({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });

    expect(telemetria.traces).toBe(true);
    expect(telemetria.metricas).toBe(true);
  });

  it('com METRICS_ENABLED=false não sobe exportador de métricas, mas traces seguem', () => {
    const telemetria = subir({
      METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });

    expect(telemetria.metricas).toBe(false);
    expect(telemetria.exportadorPrometheus).toBeUndefined();
    expect(telemetria.traces).toBe(true);
  });

  it('desligado dos dois lados não registra instrumentação nem exportador', () => {
    const telemetria = subir({ METRICS_ENABLED: 'false' });

    expect(telemetria.ativa).toBe(false);
    expect(telemetria.metricas).toBe(false);
    expect(telemetria.traces).toBe(false);
    expect(telemetria.exportadorPrometheus).toBeUndefined();
  });
});

describe('sem endpoint OTLP, o pipeline de traces não sobe de verdade', () => {
  it('não deixa o NodeSDK montar o exportador padrão para localhost:4318', () => {
    // Regressão: omitir `spanProcessors` fazia o NodeSDK cair no default derivado do
    // ambiente — um exportador OTLP para localhost:4318. O handle dizia traces:false
    // enquanto o SDK exportava mesmo assim, e o flush do encerramento passava ~8 s
    // esperando um coletor que não existe. Sem TracerProvider, o tracer global segue
    // sendo o no-op, e span no-op não grava.
    const telemetria = subir();
    const span = trace.getTracer('teste').startSpan('operacao');
    const gravando = span.isRecording();
    span.end();

    expect(telemetria.traces).toBe(false);
    expect(gravando).toBe(false);
  });

  // O caso positivo — com endpoint, o span grava e é exportado — vive em
  // tests/integration/telemetry/traces.test.ts, contra um coletor OTLP de verdade.
  // Aqui ele não caberia: o OTel registra o TracerProvider num singleton global e
  // ignora registros seguintes, então o segundo SDK deste arquivo nunca viraria o
  // provider global e o teste falharia por artefato de ordem, não por comportamento.
});

describe('iniciarTelemetria — nenhum caminho lança', () => {
  it.each([
    ['configuração vazia', {}],
    ['amostragem no piso', { OTEL_TRACES_SAMPLER_ARG: '0' }],
    ['amostragem no teto', { OTEL_TRACES_SAMPLER_ARG: '1' }],
    ['coletor em porta morta', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }],
    [
      'coletor em host inexistente',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://nao-existe.invalid:4318' },
    ],
  ])('%s não lança', (_caso, sobrescritas) => {
    expect(() => subir(sobrescritas)).not.toThrow();
  });

  it('encerrar resolve mesmo com o coletor inalcançável', async () => {
    const telemetria = iniciarTelemetria(
      config({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }),
    );

    await expect(telemetria.encerrar()).resolves.toBeUndefined();
  });

  it('encerrar de uma telemetria desligada também resolve', async () => {
    const telemetria = iniciarTelemetria(config({ METRICS_ENABLED: 'false' }));

    await expect(telemetria.encerrar()).resolves.toBeUndefined();
  });
});

describe('versaoDaAplicacao', () => {
  it('lê a versão do manifesto, no formato que vira rótulo de iam_build_info', () => {
    expect(versaoDaAplicacao()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
