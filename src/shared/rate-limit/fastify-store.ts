/**
 * Responsabilidade: adaptar o contador compartilhado ao contrato de `store` do
 * `@fastify/rate-limit`.
 * Consumido por: o registro do plugin no `app.ts`.
 * Regras:
 *  - O plugin instancia o store com `new Store(globalParams)`, então as dependências entram
 *    por fecho e não pelo construtor — daí a fábrica devolver uma classe, não um objeto.
 *  - **`child()` devolve instância nova, com a rota dentro da chave.** O plugin cria um store
 *    por rota justamente para isolá-las; devolver `this` com uma chave derivada só do IP fazia
 *    todas as rotas dividirem um balde só — três chamadas de uma rota de teto 3 barravam o
 *    login, que tem teto 5, e a janela era a de quem criasse a chave primeiro. É o mesmo
 *    caminho que o `RedisStore` do próprio plugin toma ao prefixar a chave com método e URL.
 *  - **Fail open**: falha do contador responde "zero consumido" em vez de erro. Devolver erro
 *    ao plugin viraria 500 numa rota que deveria apenas seguir.
 *  - A chave que chega do plugin é o IP (ou o que a `keyGenerator` produzir) e é hasheada
 *    antes de tocar o contador — a coleção não guarda endereço de ninguém. A rota entra no
 *    material hasheado, não no prefixo legível, pela mesma razão que a dimensão: fora do
 *    hash, dois valores diferentes poderiam colidir no mesmo digest.
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
  child(parametros?: unknown): StoreDoPlugin;
}

/**
 * O que o plugin entrega ao construtor e ao `child`: os parâmetros já mesclados da rota,
 * com `routeInfo` descrevendo qual é ela. No store global — o `new Store(globalParams)` da
 * subida — `routeInfo` vem vazio, e aí não há rota a recortar.
 */
interface ParametrosDaRota {
  readonly routeInfo?: { readonly method?: string | readonly string[]; readonly url?: string };
}

/**
 * Identidade da rota, no formato `MÉTODO url`. Vazia fora de rota.
 *
 * O método entra porque `GET /x` e `POST /x` são rotas distintas com configuração própria.
 * Quando o Fastify recebe uma lista de métodos para o mesmo handler, todos compartilham a
 * mesma configuração — então compartilham a cota, e a lista é ordenada para a chave não
 * depender da ordem em que foram declarados.
 */
function escopoDaRota(parametros: unknown): string {
  const rota = (parametros as ParametrosDaRota | undefined)?.routeInfo;
  if (rota === undefined) return '';

  const metodos: readonly string[] =
    typeof rota.method === 'string' ? [rota.method] : (rota.method ?? []);
  const metodo = [...metodos].sort().join(',');
  const url = rota.url ?? '';

  return metodo === '' && url === '' ? '' : `${metodo} ${url}`;
}

export interface DependenciasDoStoreDoPlugin {
  readonly contador: ContadorDeRateLimit;
  readonly pepper: string;
  /** Chamado quando o contador falha — alimenta métrica e log. */
  readonly aoFalhar?: () => void;
  /**
   * Chamado quando o teto por IP estoura.
   *
   * A dimensão IP não passa pela política: quem decide barrar é o próprio plugin, comparando
   * a contagem com o teto. O store aplica a mesma comparação para que o excesso apareça na
   * trilha e na métrica pelo mesmo caminho das outras duas dimensões.
   */
  readonly aoExceder?: () => void;
}

export function criarStoreDoPlugin(
  deps: DependenciasDoStoreDoPlugin,
): new (parametros?: unknown) => StoreDoPlugin {
  function chaveDe(bruta: string, escopo: string): string {
    return derivarChave('ip', bruta, deps.pepper, escopo);
  }

  /** Sem contagem conhecida, a requisição passa: é o fail open na borda do plugin. */
  function liberar(retorno: RetornoDoStore, janelaMs: number): void {
    deps.aoFalhar?.();
    retorno(null, { current: 0, ttl: janelaMs });
  }

  return class StoreCompartilhado implements StoreDoPlugin {
    /** A rota que este store atende. Vazia no store global, criado antes de haver rotas. */
    readonly #escopo: string;

    constructor(parametros?: unknown) {
      this.#escopo = escopoDaRota(parametros);
    }

    incr(chave: string, retorno: RetornoDoStore, janelaMs: number, teto?: number): void {
      deps.contador
        .incrementar(chaveDe(chave, this.#escopo), janelaMs)
        .then((estado) => {
          if (estado === null) {
            liberar(retorno, janelaMs);
            return;
          }
          // A mesma comparação que o plugin fará a seguir para responder 429.
          if (teto !== undefined && estado.contagem > teto) {
            deps.aoExceder?.();
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
        .ler(chaveDe(chave, this.#escopo))
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

    /**
     * Instância nova, e não `this`: é isto que dá balde próprio a cada rota. O plugin chama
     * uma vez por rota, no `onRoute`, passando os parâmetros já mesclados dela.
     */
    child(parametros?: unknown): StoreDoPlugin {
      return new StoreCompartilhado(parametros);
    }
  };
}
