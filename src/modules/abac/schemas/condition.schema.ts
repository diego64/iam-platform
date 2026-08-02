/**
 * Responsabilidade: schema Zod da gramática fechada da condição.
 * Regras: importado só por `routes/` e `controllers/` (o domínio usa
 * `validators/condition-limits.ts`, que não conhece Zod).
 *
 * A ordem é deliberada: os limites de forma correm **antes** da gramática (`.pipe`), porque
 * o parser recursivo do Zod é quem estouraria a pilha numa árvore profunda — validar a
 * gramática primeiro deixaria o limite chegar tarde demais.
 */
import { z } from 'zod';
import type { Condicao } from '../types/abac.types.js';
import {
  LIMITE_DE_NOS,
  LIMITE_DE_PROFUNDIDADE,
  medirCondicao,
} from '../validators/condition-limits.js';

const CAMINHO = z.string().min(1).max(128);

const referencia = z.object({ ref: CAMINHO }).strict();

const literal = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const literalOuReferencia = z.union([literal, referencia]);

const comparacao = z
  .object({
    op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
    attr: CAMINHO,
    value: literalOuReferencia,
  })
  .strict();

const pertinencia = z
  .object({ op: z.literal('in'), attr: CAMINHO, value: z.array(literal).min(1).max(100) })
  .strict();

const contencao = z
  .object({ op: z.literal('contains'), attr: CAMINHO, value: literalOuReferencia })
  .strict();

/** Gramática recursiva. `and`/`or` agregam; `not` recebe exatamente um filho. */
const gramatica: z.ZodType<Condicao> = z.lazy(() =>
  z.union([
    comparacao,
    pertinencia,
    contencao,
    z.object({ op: z.enum(['and', 'or']), of: z.array(gramatica).min(1).max(100) }).strict(),
    z.object({ op: z.literal('not'), of: z.array(gramatica).length(1) }).strict(),
  ]),
);

export const condicaoSchema = z
  .unknown()
  .superRefine((valor, ctx) => {
    const { profundidade, nos } = medirCondicao(valor);
    if (profundidade > LIMITE_DE_PROFUNDIDADE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `condição excede a profundidade máxima de ${String(LIMITE_DE_PROFUNDIDADE)}`,
      });
    }
    if (nos > LIMITE_DE_NOS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `condição excede o máximo de ${String(LIMITE_DE_NOS)} nós`,
      });
    }
  })
  .pipe(gramatica);
