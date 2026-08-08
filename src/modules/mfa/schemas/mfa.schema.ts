/**
 * Responsabilidade: schemas Zod da borda HTTP do segundo fator.
 * Regras:
 *  - Importado só por `routes/` e `controllers/`. `.strict()` — campo extra na entrada é 400.
 *  - O código de recuperação é normalizado antes de validar: ele é transcrito à mão, com
 *    hífen, espaço e caixa variável, e recusar por formatação seria recusar quem digitou
 *    certo.
 *  - Os DTOs de resposta são `.strict()` para que um `secret_encrypted` ou `code_hash`
 *    acidental quebre o contrato em vez de vazar.
 */
import { z } from 'zod';
import { FORMATO_CANONICO, normalizarCodigo } from '../services/recovery-codes.js';

export const codigoTotp = z.string().regex(/^\d{6}$/);

export const codigoDeRecuperacao = z
  .string()
  .transform((valor) => normalizarCodigo(valor))
  .pipe(z.string().regex(FORMATO_CANONICO));

export const cadastroBody = z.object({ label: z.string().min(1).max(64).optional() }).strict();
export type CadastroBody = z.infer<typeof cadastroBody>;

export const confirmacaoBody = z.object({ code: codigoTotp }).strict();
export type ConfirmacaoBody = z.infer<typeof confirmacaoBody>;

export const stepUpBody = z.object({ senha: z.string().min(8).max(128) }).strict();
export type StepUpBody = z.infer<typeof stepUpBody>;

export const verificacaoBody = z
  .object({
    // base64url de 32 bytes.
    mfa_token: z.string().length(43),
    code: codigoTotp.optional(),
    recovery_code: codigoDeRecuperacao.optional(),
  })
  .strict()
  .refine((corpo) => (corpo.code === undefined) !== (corpo.recovery_code === undefined), {
    message: 'informe code ou recovery_code, nunca os dois',
  });
export type VerificacaoBody = z.infer<typeof verificacaoBody>;

export const respostaDeCadastro = z
  .object({
    secret: z.string(),
    otpauth_uri: z.string(),
  })
  .strict();

export const respostaDeConfirmacao = z
  .object({
    status: z.literal('active'),
    confirmed_at: z.string().datetime(),
    recovery_codes: z.array(z.string()),
  })
  .strict();

export const respostaDeCodigos = z.object({ recovery_codes: z.array(z.string()) }).strict();

export const respostaDeEstado = z
  .object({
    enabled: z.boolean(),
    status: z.enum(['active', 'pending', 'none']),
    type: z.literal('totp').nullable(),
    confirmed_at: z.string().datetime().nullable(),
    last_used_at: z.string().datetime().nullable(),
    recovery_codes_remaining: z.number().int().min(0),
  })
  .strict();

export const respostaDeTokens = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
  })
  .strict();
