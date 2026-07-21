/**
 * Cobre o mixin que liga log a trace.
 *
 * Os dois casos importam igualmente: com span ativo o log precisa carregar `trace_id` e
 * `span_id`, e FORA de span precisa não carregar nada — nem vazio, nem nulo. Campo nulo
 * em log de bootstrap e de tarefa agendada polui a saída e faz o Loki indexar um valor
 * que não aponta para trace nenhum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { contextoDeTrace, criarLogger } from '../../../src/shared/logger/index.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { esquemaTelemetria } from '../../../src/config/env.js';

let telemetria: Telemetria;

beforeAll(() => {
  // Endpoint em porta morta: só é preciso um TracerProvider real para gerar span com
  // contexto válido. Nada é exportado, e o teste não depende disso.
  telemetria = iniciarTelemetria(
    esquemaTelemetria.parse({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_TRACES_SAMPLER_ARG: '1',
    }),
  );
});

afterAll(async () => {
  await telemetria.encerrar();
});

/** Captura as linhas JSON emitidas por um logger. */
function capturar(): { linhas: Record<string, unknown>[]; destino: Writable } {
  const linhas: Record<string, unknown>[] = [];
  const destino = new Writable({
    write(pedaco: Buffer, _codificacao, prosseguir): void {
      linhas.push(JSON.parse(pedaco.toString()) as Record<string, unknown>);
      prosseguir();
    },
  });
  return { linhas, destino };
}

describe('contextoDeTrace', () => {
  it('devolve trace_id e span_id dentro de um span', () => {
    const contexto = trace.getTracer('teste').startActiveSpan('operacao', (span) => {
      const resultado = contextoDeTrace();
      span.end();
      return resultado;
    });

    expect(contexto.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(contexto.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('devolve objeto vazio fora de span', () => {
    expect(contextoDeTrace()).toEqual({});
  });
});

describe('mixin do Pino', () => {
  it('acrescenta trace_id e span_id ao log emitido dentro de um span', () => {
    const { linhas, destino } = capturar();
    const logger = criarLogger({ destino });

    trace.getTracer('teste').startActiveSpan('login', (span) => {
      logger.info('login.sucesso');
      span.end();
    });

    const [linha] = linhas;
    expect(linha?.msg).toBe('login.sucesso');
    expect(linha?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(linha?.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('não acrescenta os campos fora de span — nem vazios, nem nulos', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info('boot.env_ok');

    const [linha] = linhas;
    expect(linha).not.toHaveProperty('trace_id');
    expect(linha).not.toHaveProperty('span_id');
  });

  it('o trace_id do log é o mesmo do span que o envolve', () => {
    const { linhas, destino } = capturar();
    const logger = criarLogger({ destino });

    const doSpan = trace.getTracer('teste').startActiveSpan('operacao', (span) => {
      logger.info('dentro');
      const id = span.spanContext().traceId;
      span.end();
      return id;
    });

    expect(linhas[0]?.trace_id).toBe(doSpan);
  });
});
