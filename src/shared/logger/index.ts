/**
 * Responsabilidade: fábrica do logger Pino (JSON estruturado). `console.log` é proibido no projeto.
 * Consumido por: server.ts no bootstrap e pelo Fastify como logger da instância.
 * Regras: o destino é injetável para que os testes capturem a saída sem tocar em stdout.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Writable } from 'node:stream';
import { isSpanContextValid, trace } from '@opentelemetry/api';

export type { Logger };

/**
 * Acrescenta `trace_id` e `span_id` a cada log emitido dentro de um span.
 *
 * É o que liga log e trace no Grafana: de uma linha de log, o `trace_id` abre o trace
 * correspondente no Tempo. Sem isso os dois ficam em silos e a investigação vira
 * correlação manual por horário — exatamente o trabalho que a observabilidade deveria
 * eliminar.
 *
 * Fora de span, devolve objeto vazio em vez de campos nulos: log de bootstrap e de tarefa
 * agendada não deve carregar `trace_id: null`, que polui a saída e ainda faz o Loki
 * indexar um valor que não aponta para lugar nenhum.
 *
 * Sem SDK ativo, `getActiveSpan` devolve o span no-op, cujo contexto é inválido — e a
 * checagem de validade é o que impede um `trace_id` só de zeros de vazar para o log.
 */
export function contextoDeTrace(): Record<string, string> {
  const contexto = trace.getActiveSpan()?.spanContext();

  return contexto !== undefined && isSpanContextValid(contexto)
    ? { trace_id: contexto.traceId, span_id: contexto.spanId }
    : {};
}

export interface OpcoesDeLogger {
  readonly nivel?: LoggerOptions['level'];
  /** Destino alternativo — usado nos testes para inspecionar o que foi emitido. */
  readonly destino?: Writable;
}

/**
 * Cria um logger JSON. Sem destino informado, escreve em stdout.
 * O nível padrão é `info`: antes da validação da env não existe LOG_LEVEL confiável.
 */
export function criarLogger(opcoes: OpcoesDeLogger = {}): Logger {
  const { nivel = 'info', destino } = opcoes;
  const configuracao: LoggerOptions = { level: nivel, mixin: contextoDeTrace };

  return destino ? pino(configuracao, destino) : pino(configuracao);
}
