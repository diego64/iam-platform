/**
 * Responsabilidade: fábrica do logger Pino (JSON estruturado). `console.log` é proibido no projeto.
 * Consumido por: server.ts no bootstrap e pelo Fastify como logger da instância.
 * Regras: o destino é injetável para que os testes capturem a saída sem tocar em stdout.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Writable } from 'node:stream';
import { caminhosDeCensura } from './redact.js';

export type { Logger };

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
  const configuracao: LoggerOptions = {
    level: nivel,
    // Censura senha, token e hash em todo log — inclusive nos logs de requisição que o
    // Fastify emite com o corpo. `censored` deixa claro na saída que houve redação.
    redact: { paths: caminhosDeCensura(), censor: '[censurado]' },
  };

  return destino ? pino(configuracao, destino) : pino(configuracao);
}
