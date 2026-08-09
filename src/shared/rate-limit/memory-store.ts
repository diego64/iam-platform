/**
 * Responsabilidade: contador de rate limit na memória do processo.
 * Consumido por: desenvolvimento, testes, e o modo `RATE_LIMIT_STORE=memory`.
 * Regras:
 *  - Janela fixa: a contagem zera quando a janela vence, não desliza. Deslizante exigiria
 *    guardar um timestamp por tentativa — documento maior e escrita mais cara para uma
 *    precisão que não muda a decisão de barrar.
 *  - Expurgo preguiçoso: a entrada vencida some quando a chave é tocada de novo. Um
 *    varredor periódico seria um timer a gerenciar no processo para limpar um Map que, em
 *    desenvolvimento, tem dezenas de entradas.
 *  - **Não serve para produção com mais de uma instância**: cada processo teria a própria
 *    contagem, e o teto efetivo passaria a ser o número de réplicas vezes o configurado.
 */
import type { ContadorDeRateLimit, EstadoDaJanela } from './types.js';

interface Entrada {
  contagem: number;
  expiraEm: number;
}

export interface OpcoesDoContadorEmMemoria {
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export function criarContadorEmMemoria(
  opcoes: OpcoesDoContadorEmMemoria = {},
): ContadorDeRateLimit {
  const agora = opcoes.agora ?? Date.now;
  const entradas = new Map<string, Entrada>();

  /** Devolve a entrada viva da chave, descartando a vencida no caminho. */
  function viva(chave: string): Entrada | undefined {
    const entrada = entradas.get(chave);
    if (entrada === undefined) return undefined;
    if (entrada.expiraEm <= agora()) {
      entradas.delete(chave);
      return undefined;
    }
    return entrada;
  }

  return {
    incrementar(chave: string, janelaMs: number): Promise<EstadoDaJanela> {
      const atual = viva(chave);
      if (atual === undefined) {
        const nova: Entrada = { contagem: 1, expiraEm: agora() + janelaMs };
        entradas.set(chave, nova);
        return Promise.resolve({ contagem: 1, expiraEm: new Date(nova.expiraEm) });
      }

      atual.contagem += 1;
      return Promise.resolve({
        contagem: atual.contagem,
        expiraEm: new Date(atual.expiraEm),
      });
    },

    ler(chave: string): Promise<EstadoDaJanela> {
      const atual = viva(chave);
      // Chave sem contagem é uma resposta válida (zero), não uma falha.
      return Promise.resolve(
        atual === undefined
          ? { contagem: 0, expiraEm: new Date(agora()) }
          : { contagem: atual.contagem, expiraEm: new Date(atual.expiraEm) },
      );
    },
  };
}
