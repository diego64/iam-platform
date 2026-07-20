/**
 * Responsabilidade: schemas Zod da borda HTTP do módulo health.
 * Regras: importado apenas por routes/ e controllers/ (regra de dependência do CLAUDE.md).
 */
import { z } from 'zod';

export const respostaLiveSchema = z
  .object({
    status: z.literal('ok'),
    uptime_seconds: z.number().int().nonnegative(),
  })
  .strict();

export type RespostaLive = z.infer<typeof respostaLiveSchema>;
