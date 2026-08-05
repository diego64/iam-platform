/**
 * Responsabilidade: guardar um valor por uma janela de tempo, em memória.
 * Consumido por: a visão agregada do painel administrativo.
 * Regras:
 *  - Uma entrada por chave, sem limite de tamanho: quem usa isto guarda punhados de
 *    contadores, não um catálogo. Precisando de despejo por tamanho, o lugar é um cache de
 *    verdade, não este arquivo.
 *  - Janela zero desliga o cache — é o modo que os testes usam para ver a apuração real.
 *  - Em memória e por processo. Com várias réplicas, cada uma tem a sua janela e os valores
 *    podem divergir dentro dela; quem consome precisa tolerar isso ou usar outro mecanismo.
 */
export interface CacheComTtl<T> {
  /** O valor vigente, ou `null` quando não há entrada ou ela venceu. */
  obter(chave: string): T | null;
  gravar(chave: string, valor: T): void;
  invalidar(chave: string): void;
}

interface Entrada<T> {
  readonly valor: T;
  readonly expiraEm: number;
}

export function criarCacheComTtl<T>(
  janelaMs: number,
  agora: () => number = Date.now,
): CacheComTtl<T> {
  const entradas = new Map<string, Entrada<T>>();

  return {
    obter(chave: string): T | null {
      if (janelaMs <= 0) return null;
      const entrada = entradas.get(chave);
      if (entrada === undefined) return null;
      if (agora() >= entrada.expiraEm) {
        entradas.delete(chave);
        return null;
      }
      return entrada.valor;
    },

    gravar(chave: string, valor: T): void {
      if (janelaMs <= 0) return;
      entradas.set(chave, { valor, expiraEm: agora() + janelaMs });
    },

    invalidar(chave: string): void {
      entradas.delete(chave);
    },
  };
}
