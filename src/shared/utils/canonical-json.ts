/**
 * Responsabilidade: serializar um valor em JSON determinístico, para que o mesmo conteúdo
 * produza sempre a mesma string — e, portanto, o mesmo hash.
 * Consumido por: o encadeamento por hash da trilha de auditoria.
 * Regras:
 *  - Chaves ordenadas recursivamente: a ordem de inserção do objeto não pode mudar o hash.
 *  - `undefined` some dentro de objeto (como no JSON.stringify) e vira `null` dentro de
 *    array, para o índice do elemento seguinte não escorregar.
 *  - `Date` vira ISO-8601 em UTC. Sem isso, a mesma data reconstruída de fuso diferente
 *    produziria bytes diferentes.
 *  - Número não finito é recusado: `JSON.stringify` transforma NaN e Infinity em `null`
 *    silenciosamente, e um hash sobre `null` esconderia que o dado estava quebrado.
 *  - Inteiro grande sai por extenso, nunca em notação exponencial: `1e21` e
 *    `1000000000000000000000` são o mesmo número e precisam da mesma representação.
 */

/** Valor aceito pela canonicalização. Ponteiro cíclico não é aceito e estoura a pilha. */
export type ValorCanonico =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | readonly ValorCanonico[]
  | { readonly [chave: string]: ValorCanonico };

function serializarNumero(valor: number): string {
  if (!Number.isFinite(valor)) {
    throw new TypeError('canonicalizar: número não finito não tem representação estável');
  }
  // `String(1e21)` devolve "1e+21"; o BigInt escreve todos os dígitos. Vale para qualquer
  // double integral, inclusive acima de MAX_SAFE_INTEGER: a conversão é exata sobre o
  // valor que o double de fato representa, que é o único valor que existe para hashear.
  if (Number.isInteger(valor)) {
    return BigInt(valor).toString();
  }
  return JSON.stringify(valor);
}

function serializar(valor: ValorCanonico): string {
  if (valor === null || valor === undefined) return 'null';
  if (valor instanceof Date) return JSON.stringify(valor.toISOString());

  switch (typeof valor) {
    case 'string':
      return JSON.stringify(valor);
    case 'number':
      return serializarNumero(valor);
    case 'boolean':
      return valor ? 'true' : 'false';
    default:
      break;
  }

  if (Array.isArray(valor)) {
    return `[${valor.map((item: ValorCanonico) => serializar(item)).join(',')}]`;
  }

  const objeto = valor as { readonly [chave: string]: ValorCanonico };
  const partes = Object.keys(objeto)
    .sort()
    .filter((chave) => objeto[chave] !== undefined)
    .map((chave) => `${JSON.stringify(chave)}:${serializar(objeto[chave])}`);
  return `{${partes.join(',')}}`;
}

/** JSON determinístico do valor: mesma estrutura ⇒ mesma string, sempre. */
export function canonicalizar(valor: ValorCanonico): string {
  return serializar(valor);
}
