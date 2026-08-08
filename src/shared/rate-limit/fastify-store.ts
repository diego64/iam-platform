/**
 * Responsabilidade: adaptar o contador compartilhado ao contrato de `store` do
 * `@fastify/rate-limit`.
 * Consumido por: o registro do plugin no `app.ts`.
 * Regras:
 *  - O plugin instancia o store com `new Store(globalParams)`, então as dependências entram
 *    por fecho e não pelo construtor — daí a fábrica devolver uma classe, não um objeto.
 *  - `child()` devolve a mesma instância: o contador é externo e compartilhado, e não há
 *    estado por rota a isolar. As instâncias por rota do plugin existem para separar caches
 *    locais, problema que não existe aqui.
 *  - **Fail open**: falha do contador responde "zero consumido" em vez de erro. Devolver erro
 *    ao plugin viraria 500 numa rota que deveria apenas seguir.
 *  - A chave que chega do plugin é o IP (ou o que a `keyGenerator` produzir) e é hasheada
 *    antes de tocar o contador — a coleção não guarda endereço de ninguém.
 */
import { derivarChave } from './chave.js';
import type { ContadorDeRateLimit } from './types.js';

/** O formato que o plugin espera de volta: consumo atual e o que falta da janela, em ms. */
interface EstadoDoPlugin {
  readonly current: number;
  readonly ttl: number;
}

type RetornoDoStore = (erro: Error | null, estado: EstadoDoPlugin) => void;

export interface StoreDoPlugin {
  incr(chave: string, retorno: RetornoDoStore, janelaMs: number, teto?: number): void;
  read(chave: string, retorno: RetornoDoStore, janelaMs: number, teto?: number): void;
  child(): StoreDoPlugin;
}

export interface DependenciasDoStoreDoPlugin {
  readonly contador: ContadorDeRateLimit;
  readonly pepper: string;
  /** Chamado quando o contador falha — alimenta métrica e log. */
  readonly aoFalhar?: () => void;
}

export function criarStoreDoPlugin(
  deps: DependenciasDoStoreDoPlugin,
): new (parametros?: unknown) => StoreDoPlugin {
  function chaveDe(bruta: string): string {
    return derivarChave('ip', bruta, deps.pepper);
  }

  /** Sem contagem conhecida, a requisição passa: é o fail open na borda do plugin. */
  function liberar(retorno: RetornoDoStore, janelaMs: number): void {
    deps.aoFalhar?.();
    retorno(null, { current: 0, ttl: janelaMs });
  }

  return class StoreCompartilhado implements StoreDoPlugin {
    incr(chave: string, retorno: RetornoDoStore, janelaMs: number): void {
      deps.contador
        .incrementar(chaveDe(chave), janelaMs)
        .then((estado) => {
          if (estado === null) {
            liberar(retorno, janelaMs);
            return;
          }
          retorno(null, {
            current: estado.contagem,
            ttl: Math.max(0, estado.expiraEm.getTime() - Date.now()),
          });
        })
        .catch(() => {
          // O contrato do contador diz que ele não lança; se lançar, o efeito é o mesmo.
          liberar(retorno, janelaMs);
        });
    }

    read(chave: string, retorno: RetornoDoStore, janelaMs: number): void {
      deps.contador
        .ler(chaveDe(chave))
        .then((estado) => {
          if (estado === null) {
            liberar(retorno, janelaMs);
            return;
          }
          retorno(null, {
            current: estado.contagem,
            ttl: Math.max(0, estado.expiraEm.getTime() - Date.now()),
          });
        })
        .catch(() => {
          liberar(retorno, janelaMs);
        });
    }

    child(): StoreDoPlugin {
      return this;
    }
  };
}
