/**
 * Responsabilidade: schemas Zod da borda HTTP de autenticação.
 * Regras: importado só por routes/ e controllers/. `.strict()` em corpos e respostas — campo
 * extra na entrada é 400; na saída, é vazamento barrado pelo serializer.
 */
import { z } from 'zod';

export const loginBody = z
  .object({
    email: z.string().email().max(254),
    senha: z.string().min(8).max(128),
  })
  .strict();
export type LoginBody = z.infer<typeof loginBody>;

export const respostaComTokens = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
  })
  .strict();

/**
 * O login parou no primeiro fator. Sem `access_token` de propósito: o cliente que ignorar a
 * diferença e ler o token direto recebe `undefined`, não um token pela metade.
 */
export const respostaDeDesafioDeMfa = z
  .object({
    mfa_required: z.literal(true),
    mfa_token: z.string(),
    expires_in: z.number().int().positive(),
  })
  .strict();

/**
 * As duas formas do 200 do login. A união é discriminada por `mfa_required`; o OpenAPI a
 * publica como `oneOf`.
 */
export const respostaLogin = z.union([respostaComTokens, respostaDeDesafioDeMfa]);

export const logoutBody = z
  .object({
    // Refresh opaco: 64 bytes em base64 = 88 caracteres.
    refresh_token: z.string().length(88),
  })
  .strict();

export const respostaMe = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    status: z.string(),
    roles: z.array(z.string()),
  })
  .strict();
