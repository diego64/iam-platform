/**
 * Responsabilidade: o contrato do contador de rate limit, independente de onde ele mora.
 * Consumido por: a política de limite, os stores (memória e Mongo) e quem os injeta.
 * Regras:
 *  - Nenhuma das duas operações **lança** por falha de I/O: elas devolvem `null`, e quem
 *    chama trata isso como "não sei" e deixa passar. Rate limit é proteção de disponibilidade;
 *    negar quando o contador está fora transformaria queda do banco em queda do login.
 *  - Contrato pequeno de propósito: trocar Mongo por Redis é implementar estas duas funções.
 */

export interface EstadoDaJanela {
  readonly contagem: number;
  readonly expiraEm: Date;
}

export interface ContadorDeRateLimit {
  /** Soma 1 à chave e devolve o estado da janela; `null` quando o contador falhou. */
  incrementar(chave: string, janelaMs: number): Promise<EstadoDaJanela | null>;
  /**
   * Lê sem somar — o "verificar antes" das dimensões conta e cliente, que só debitam depois
   * de saber se a tentativa falhou. Chave inexistente devolve contagem 0, não `null`: não
   * ter contagem é uma resposta válida, diferente de não conseguir responder.
   */
  ler(chave: string): Promise<EstadoDaJanela | null>;
}

/** As três dimensões independentes. O rótulo de métrica sai daqui — lista fechada. */
export type DimensaoDeLimite = 'ip' | 'conta' | 'cliente';
