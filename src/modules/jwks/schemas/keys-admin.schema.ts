/**
 * Responsabilidade: schemas Zod da borda administrativa de chaves.
 * Regras: importado só por routes/ e controllers/. `.strict()` na entrada e na saída — a
 * resposta estrita é a garantia de contrato de que nenhum campo de material de chave
 * escapa: um `private_key_enc` ou `d` acidental quebra o teste em vez de vazar.
 */
import { z } from 'zod';

const STATUS = z.enum(['active', 'next', 'retired']);

export const listarChavesQuery = z.object({ status: STATUS.optional() }).strict();
export type ListarChavesQuery = z.infer<typeof listarChavesQuery>;

export const kidParams = z.object({ kid: z.string().uuid() }).strict();
export type KidParams = z.infer<typeof kidParams>;

export const rotacionarBody = z.object({ motivo: z.string().min(3).max(256).optional() }).strict();
export type RotacionarBody = z.infer<typeof rotacionarBody>;

// Motivo obrigatório: revogação sempre tem causa, e ela precisa sobreviver no log.
export const revogarBody = z.object({ motivo: z.string().min(3).max(256) }).strict();
export type RevogarBody = z.infer<typeof revogarBody>;

export const chaveMetadados = z
  .object({
    kid: z.string().uuid(),
    algorithm: z.literal('EdDSA'),
    status: STATUS,
    created_at: z.string().datetime(),
    activated_at: z.string().datetime().nullable(),
    retired_at: z.string().datetime().nullable(),
    verifiable_until: z.string().datetime().nullable(),
    age_seconds: z.number().int().nonnegative(),
  })
  .strict();

export const respostaListaDeChaves = z
  .object({ items: z.array(chaveMetadados), total: z.number().int().nonnegative() })
  .strict();

export const respostaChavePreparada = z
  .object({
    kid: z.string().uuid(),
    status: z.literal('next'),
    created_at: z.string().datetime(),
    rotatable_at: z.string().datetime(),
  })
  .strict();

export const respostaRotacao = z
  .object({
    previous_kid: z.string().uuid().nullable(),
    active_kid: z.string().uuid(),
    next_kid: z.string().uuid(),
    verifiable_until: z.string().datetime().nullable(),
  })
  .strict();

export const respostaRevogacao = z
  .object({
    revoked_kid: z.string().uuid(),
    active_kid: z.string().uuid().nullable(),
    tokens_invalidated: z.boolean(),
  })
  .strict();
