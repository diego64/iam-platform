/**
 * Responsabilidade: avaliar uma condição da gramática fechada contra o contexto de decisão.
 * Consumido por: o motor PDP (`policy-engine.ts`).
 *
 * Regras — todas críticas de segurança:
 *  - **Sem execução de dado.** Nenhum `eval`, `new Function` ou regex vinda da política. O
 *    conjunto de operadores é fechado; `op` desconhecido resolve `false` (fail closed), mesmo
 *    que a política tenha entrado no banco por fora da borda Zod.
 *  - **Resolução de atributo à prova de prototype pollution.** O caminho anda só por objetos
 *    planos e só por propriedades próprias; `__proto__`, `prototype` e `constructor` resolvem
 *    `undefined` em vez de alcançar a cadeia de protótipos.
 *  - **Nunca lança.** Um erro aqui viraria 500 num caminho de autorização; o contrato é
 *    devolver `false`, que o motor traduz em negação.
 *  - Atributo ausente compara `false`, exceto em `ne` — "não é igual" é verdade quando o
 *    atributo nem existe.
 */
import type {
  Condicao,
  ContextoDeDecisao,
  JsonValue,
  LiteralDeCondicao,
  ReferenciaDeAtributo,
} from '../types/abac.types.js';

/** Segmentos que alcançariam a cadeia de protótipos se fossem seguidos. */
const SEGMENTOS_PROIBIDOS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Data em ISO-8601. Padrão fixo e ancorado, escrito aqui e nunca vindo de política — é o
 * que permite comparar `env.now` com um horário sem abrir espaço para ReDoS.
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

type ValorResolvido = JsonValue | Date | undefined;

function ehObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Raiz endereçável pelos caminhos das condições — exatamente os atributos de RF-05. */
function raizDoContexto(contexto: ContextoDeDecisao): Record<string, unknown> {
  return {
    subject: contexto.subject,
    resource: contexto.resource,
    action: contexto.action,
    env: contexto.env,
  };
}

/**
 * Resolve `a.b.c` no contexto. Devolve `undefined` para caminho inexistente, segmento
 * proibido ou travessia que passaria por algo que não é objeto plano.
 */
export function resolverAtributo(caminho: string, contexto: ContextoDeDecisao): ValorResolvido {
  if (caminho.length === 0) return undefined;

  let atual: unknown = raizDoContexto(contexto);
  for (const segmento of caminho.split('.')) {
    if (segmento.length === 0 || SEGMENTOS_PROIBIDOS.has(segmento)) return undefined;
    if (!ehObjetoPlano(atual)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(atual, segmento)) return undefined;
    atual = atual[segmento];
  }
  return atual as ValorResolvido;
}

function ehReferencia(valor: unknown): valor is ReferenciaDeAtributo {
  return ehObjetoPlano(valor) && typeof valor['ref'] === 'string';
}

/** `value` de um nó: literal como está, ou o atributo apontado por `{ ref }`. */
function resolverValor(
  valor: LiteralDeCondicao | ReferenciaDeAtributo,
  contexto: ContextoDeDecisao,
): ValorResolvido {
  return ehReferencia(valor) ? resolverAtributo(valor.ref, contexto) : valor;
}

/** Converte para um número comparável. Só número e data ordenam; o resto é incomparável. */
function paraOrdenavel(valor: ValorResolvido): number | undefined {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : undefined;
  if (valor instanceof Date) {
    const t = valor.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof valor === 'string' && ISO_8601.test(valor)) {
    const t = Date.parse(valor);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Igualdade estrita, com datas comparadas pelo instante e não pela identidade do objeto. */
function saoIguais(a: ValorResolvido, b: ValorResolvido): boolean {
  if (a instanceof Date || b instanceof Date) {
    const [x, y] = [paraOrdenavel(a), paraOrdenavel(b)];
    return x !== undefined && y !== undefined && x === y;
  }
  return a === b;
}

function compararOrdenaveis(
  a: ValorResolvido,
  b: ValorResolvido,
  satisfaz: (x: number, y: number) => boolean,
): boolean {
  const [x, y] = [paraOrdenavel(a), paraOrdenavel(b)];
  return x !== undefined && y !== undefined && satisfaz(x, y);
}

export function avaliarCondicao(condicao: Condicao, contexto: ContextoDeDecisao): boolean {
  switch (condicao.op) {
    case 'and':
      return condicao.of.length > 0 && condicao.of.every((f) => avaliarCondicao(f, contexto));
    case 'or':
      return condicao.of.some((f) => avaliarCondicao(f, contexto));
    case 'not': {
      const filho = condicao.of[0];
      // Fora da gramática (`not` sempre tem um filho): nega nada, então nega o acesso.
      return filho === undefined ? false : !avaliarCondicao(filho, contexto);
    }
    case 'eq':
      return saoIguais(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
      );
    case 'ne':
      return !saoIguais(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
      );
    case 'gt':
      return compararOrdenaveis(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
        (x, y) => x > y,
      );
    case 'gte':
      return compararOrdenaveis(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
        (x, y) => x >= y,
      );
    case 'lt':
      return compararOrdenaveis(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
        (x, y) => x < y,
      );
    case 'lte':
      return compararOrdenaveis(
        resolverAtributo(condicao.attr, contexto),
        resolverValor(condicao.value, contexto),
        (x, y) => x <= y,
      );
    case 'in': {
      const alvo = resolverAtributo(condicao.attr, contexto);
      return Array.isArray(alvo) ? false : condicao.value.some((v) => saoIguais(alvo, v));
    }
    case 'contains': {
      const alvo = resolverAtributo(condicao.attr, contexto);
      if (!Array.isArray(alvo)) return false;
      const procurado = resolverValor(condicao.value, contexto);
      return alvo.some((item) => saoIguais(item, procurado));
    }
    default:
      // `op` fora da gramática só chega aqui se a política escapou da validação da borda.
      return false;
  }
}
