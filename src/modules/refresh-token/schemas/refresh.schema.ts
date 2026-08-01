/**
 * Responsabilidade: schemas Zod da borda HTTP do refresh token.
 * Regras: importado só por routes/ e controllers/. `.strict()` — campo extra na entrada é 400.
 */
import { z } from 'zod';

export const refreshBody = z
  .object({
    // Refresh opaco: 64 bytes em base64 = 88 caracteres (mesmo formato aceito no logout).
    refresh_token: z.string().length(88),
  })
  .strict();
export type RefreshBody = z.infer<typeof refreshBody>;

export const respostaRefresh = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
  })
  .strict();
