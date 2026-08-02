/**
 * Responsabilidade: schemas Zod da borda HTTP do ABAC.
 * Regras: importado só por `routes/` e `controllers/`. `.strict()` nos corpos — campo extra
 * na entrada é 400. Respostas modelam exatamente o DTO (snake_case).
 *
 * `condition` reusa a gramática fechada de `condition.schema.ts`, que já traz os limites de
 * forma: a condição é recusada com 400 antes de chegar ao serviço e ao banco.
 */
import { z } from 'zod';
import { condicaoSchema } from './condition.schema.js';

const NOME_DE_POLITICA = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);

/** Tipo de recurso e ação aceitam o curinga `*` — é assim que uma política vale para todos. */
const ALVO = z.string().min(1).max(64);

export const idParams = z.object({ id: z.string().uuid() }).strict();
export type IdParams = z.infer<typeof idParams>;

export const listarPoliticasQuery = z
  .object({
    resource_type: ALVO.optional(),
    enabled: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListarPoliticasQuery = z.infer<typeof listarPoliticasQuery>;

export const criarPoliticaBody = z
  .object({
    name: NOME_DE_POLITICA,
    description: z.string().max(256).optional(),
    effect: z.enum(['permit', 'deny']),
    resource_type: ALVO,
    action: ALVO,
    condition: condicaoSchema,
    priority: z.number().int().min(0).max(1000).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CriarPoliticaBody = z.infer<typeof criarPoliticaBody>;

export const atualizarPoliticaBody = z
  .object({
    name: NOME_DE_POLITICA.optional(),
    description: z.string().max(256).nullable().optional(),
    effect: z.enum(['permit', 'deny']).optional(),
    resource_type: ALVO.optional(),
    action: ALVO.optional(),
    condition: condicaoSchema.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type AtualizarPoliticaBody = z.infer<typeof atualizarPoliticaBody>;

/**
 * O simulador recebe os atributos do recurso prontos: ele não carrega nada do banco, é o
 * chamador que descreve a situação a avaliar.
 */
export const avaliarBody = z
  .object({
    subject: z
      .object({
        sub: z.string().min(1).max(128),
        roles: z.array(z.string().max(64)).max(100).default([]),
        perm: z.array(z.string().max(64)).max(500).default([]),
      })
      .strict(),
    resource_type: ALVO,
    resource: z.record(z.unknown()),
    action: ALVO,
    env: z
      .object({ ip: z.string().ip().optional(), now: z.string().datetime().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type AvaliarBody = z.infer<typeof avaliarBody>;

const politicaDTO = z.object({
  id: z.string().uuid(),
  name: z.string(),
  effect: z.enum(['permit', 'deny']),
  resource_type: z.string(),
  action: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  is_system: z.boolean(),
});

export const respostaPolitica = politicaDTO;
export const respostaPoliticaDetalhe = politicaDTO.extend({
  description: z.string().nullable(),
  condition: z.unknown(),
});
export const respostaListaPoliticas = z.object({
  items: z.array(politicaDTO),
  total: z.number().int(),
});

export const respostaDecisao = z.object({
  effect: z.enum(['permit', 'deny']),
  policy_id: z.string().uuid().optional(),
  reason: z.enum(['matched', 'no-applicable-policy']),
});
