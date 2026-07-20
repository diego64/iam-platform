/**
 * Responsabilidade: encerramento gracioso — drenar requisições em voo e fechar
 * as conexões antes de sair.
 * Regras: recebe tudo por injeção (inclusive o encerrador do processo) para ser
 *         testável sem disparar sinais reais nem matar o runner de teste.
 */
import type { Logger } from '../shared/logger/index.js';

/** Contratos mínimos — evitam acoplar o encerrador aos tipos do Fastify/pg/mongodb. */
export interface RecursosDeEncerramento {
  readonly app: { close(): Promise<void> };
  readonly pool: { end(): Promise<void> };
  readonly mongo: { close(): Promise<void> };
  readonly logger: Logger;
  readonly timeoutMs: number;
  /** Injetado para o teste observar o código de saída em vez de derrubar o processo. */
  readonly encerrarProcesso: (codigo: number) => void;
  /**
   * Chamado ANTES de app.close(), para o readiness passar a 503 enquanto a instância
   * ainda drena. Sem isso, o balanceador segue mandando tráfego novo até o socket
   * fechar — e essas requisições chegam a um processo que já está desligando.
   */
  readonly aoIniciarEncerramento?: () => void;
}

/**
 * Devolve o handler de encerramento.
 *
 * Ordem: parar de aceitar conexões (app.close drena as em voo) → devolver as conexões
 * do PostgreSQL → fechar os sockets do Mongo. Inverter isso derrubaria o banco debaixo
 * de uma requisição que ainda está sendo respondida.
 *
 * O timer duro existe porque app.close pode nunca resolver se um handler travar: sem
 * ele o container ficaria pendurado até o SIGKILL do orquestrador, perdendo as respostas
 * em voo — exatamente o que o graceful shutdown deveria evitar.
 */
export function criarEncerrador(
  recursos: RecursosDeEncerramento,
): (sinal: string) => Promise<void> {
  const { app, pool, mongo, logger, timeoutMs, encerrarProcesso, aoIniciarEncerramento } = recursos;
  let encerrando = false;

  return async function encerrar(sinal: string): Promise<void> {
    // Sinal repetido durante o encerramento é ruído: um segundo Ctrl+C não deve
    // reentrar na sequência e fechar duas vezes o que já está fechando.
    if (encerrando) {
      logger.warn({ sinal }, 'encerramento já em curso — sinal ignorado');
      return;
    }
    encerrando = true;

    // Primeiro sinaliza a indisponibilidade, só depois começa a fechar. A ordem é o
    // ponto: marcar depois do app.close() deixaria o balanceador enviando tráfego
    // durante todo o dreno.
    aoIniciarEncerramento?.();

    const inicio = Date.now();
    logger.warn({ sinal }, 'shutdown.started');

    const estouro = setTimeout(() => {
      logger.fatal({ sinal, timeoutMs }, 'shutdown.timeout');
      encerrarProcesso(1);
    }, timeoutMs);

    try {
      await app.close();
      await pool.end();
      await mongo.close();

      clearTimeout(estouro);
      logger.info({ sinal, duracao_ms: Date.now() - inicio }, 'shutdown.completed');
      encerrarProcesso(0);
    } catch (erro) {
      clearTimeout(estouro);
      logger.fatal({ sinal, err: erro }, 'shutdown.failed');
      encerrarProcesso(1);
    }
  };
}
