/**
 * Responsabilidade: os limites de forma da condição (profundidade e nº de nós).
 * Consumido por: o schema Zod da borda (400 antes de persistir) e o serviço, que revalida
 * sem depender de Zod — o domínio não importa Zod (CLAUDE.md).
 *
 * Regras:
 *  - A varredura é **iterativa**, com pilha explícita: uma condição maliciosamente profunda
 *    derrubaria uma versão recursiva por estouro de pilha antes de qualquer limite valer, e
 *    é justamente contra isso que o limite existe.
 *  - Roda sobre `unknown`: precede a validação da gramática, senão o parser recursivo do Zod
 *    encara a árvore profunda primeiro.
 */

export const LIMITE_DE_PROFUNDIDADE = 10;
export const LIMITE_DE_NOS = 100;

export interface MedidaDaCondicao {
  readonly profundidade: number;
  readonly nos: number;
}

interface Pendente {
  readonly no: unknown;
  readonly nivel: number;
}

function ehNo(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Mede a árvore. Para de contar assim que ultrapassa um dos limites — o resultado só
 * precisa ser fiel até a fronteira, e parar cedo é o que impede a medição de virar o DoS.
 */
export function medirCondicao(raiz: unknown): MedidaDaCondicao {
  let nos = 0;
  let profundidade = 0;
  const pilha: Pendente[] = [{ no: raiz, nivel: 1 }];

  for (let atual = pilha.pop(); atual !== undefined; atual = pilha.pop()) {
    if (!ehNo(atual.no)) continue;
    nos += 1;
    if (atual.nivel > profundidade) profundidade = atual.nivel;
    if (nos > LIMITE_DE_NOS || profundidade > LIMITE_DE_PROFUNDIDADE) break;

    const filhos = atual.no['of'];
    if (Array.isArray(filhos)) {
      for (const filho of filhos) pilha.push({ no: filho, nivel: atual.nivel + 1 });
    }
  }

  return { profundidade, nos };
}

export function condicaoDentroDosLimites(raiz: unknown): boolean {
  const { profundidade, nos } = medirCondicao(raiz);
  return profundidade <= LIMITE_DE_PROFUNDIDADE && nos <= LIMITE_DE_NOS;
}
