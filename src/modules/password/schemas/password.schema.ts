/**
 * Responsabilidade: os schemas Zod das rotas de senha (borda HTTP).
 * Consumido por: `routes/` e `controllers/` desta SPEC.
 * Regras: `.strict()` em todos os bodies — campo extra ⇒ 400 (anti mass-assignment).
 */
import { z } from 'zod';
import { senhaForte } from './senha-forte.js';

/** Comprimento base64url de 32 bytes = 43 caracteres. */
const TAMANHO_TOKEN_RESET = 43;

export const trocarSenhaBody = z
  .object({
    senha_atual: z.string().min(1).max(128),
    senha_nova: senhaForte,
  })
  .strict();

export const esqueciSenhaBody = z
  .object({
    email: z.string().email().max(254),
  })
  .strict();

export const resetSenhaBody = z
  .object({
    token: z.string().length(TAMANHO_TOKEN_RESET),
    senha_nova: senhaForte,
  })
  .strict();

export type TrocarSenhaBody = z.infer<typeof trocarSenhaBody>;
export type EsqueciSenhaBody = z.infer<typeof esqueciSenhaBody>;
export type ResetSenhaBody = z.infer<typeof resetSenhaBody>;
