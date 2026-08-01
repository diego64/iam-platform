/**
 * Responsabilidade: schemas Zod da borda HTTP das sessões.
 * Regras: importado só por routes/ e controllers/. `.strict()` nas saídas barra vazamento de
 * campo; o id é validado como UUID antes de qualquer consulta.
 */
import { z } from 'zod';

export const paramsSessao = z.object({ id: z.string().uuid() }).strict();
export type ParamsSessao = z.infer<typeof paramsSessao>;

export const respostaListagem = z
  .object({
    sessions: z.array(
      z
        .object({
          id: z.string().uuid(),
          current: z.boolean(),
          ip: z.string().nullable(),
          user_agent: z.string().nullable(),
          created_at: z.string().datetime(),
          last_seen_at: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const respostaRevogarOutras = z
  .object({ revogadas: z.number().int().nonnegative() })
  .strict();
