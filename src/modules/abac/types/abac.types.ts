/**
 * Tipos do domínio de ABAC: a gramática fechada da condição, o contexto de decisão e o
 * resultado do PDP. Nenhum import de Fastify, Zod ou driver de banco — o avaliador e o
 * motor dependem só destes tipos.
 *
 * A gramática é fechada de propósito: cada nó é um dos operadores abaixo e nada mais.
 * Não existe nó que carregue código, regex ou chamada — o teto de expressividade é o
 * preço de não ter superfície de execução de dado.
 */

/** Valor JSON arbitrário — o que um recurso carregado pode trazer como atributo. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Literal aceito no `value` de uma condição. */
export type LiteralDeCondicao = string | number | boolean | null;

/** `value` que aponta para outro atributo do contexto em vez de um literal. */
export interface ReferenciaDeAtributo {
  readonly ref: string;
}

export type OperadorDeComparacao = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

export type Condicao =
  | {
      readonly op: OperadorDeComparacao;
      readonly attr: string;
      readonly value: LiteralDeCondicao | ReferenciaDeAtributo;
    }
  /** valor de `attr` pertence à lista */
  | { readonly op: 'in'; readonly attr: string; readonly value: readonly LiteralDeCondicao[] }
  /** `attr` é um array que contém o valor */
  | {
      readonly op: 'contains';
      readonly attr: string;
      readonly value: LiteralDeCondicao | ReferenciaDeAtributo;
    }
  | { readonly op: 'and' | 'or'; readonly of: readonly Condicao[] }
  | { readonly op: 'not'; readonly of: readonly Condicao[] };

/** Sujeito da decisão — exatamente os claims do token, sem enriquecimento no banco. */
export interface SujeitoDaDecisao {
  readonly sub: string;
  readonly roles: readonly string[];
  readonly perm: readonly string[];
}

export interface AmbienteDaDecisao {
  readonly ip?: string;
  readonly now: Date;
}

export interface ContextoDeDecisao {
  readonly subject: SujeitoDaDecisao;
  readonly resourceType: string;
  readonly resource: Readonly<Record<string, JsonValue>>;
  readonly action: string;
  readonly env: AmbienteDaDecisao;
}

export type Efeito = 'permit' | 'deny';

/** `no-applicable-policy` é o deny padrão: nenhuma política aplicável foi satisfeita. */
export type MotivoDaDecisao = 'matched' | 'no-applicable-policy';

export interface Decisao {
  readonly effect: Efeito;
  readonly policyId?: string;
  readonly reason: MotivoDaDecisao;
}

export interface Politica {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly effect: Efeito;
  readonly resourceType: string;
  readonly action: string;
  readonly condition: Condicao;
  readonly priority: number;
  readonly enabled: boolean;
  readonly isSystem: boolean;
}
