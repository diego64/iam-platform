/**
 * Responsabilidade: schemas Zod da borda HTTP do módulo health.
 * Regras: importado apenas por routes/ e controllers/ (regra de dependência do CLAUDE.md).
 *         `.strict()` em tudo: a resposta é pública e sem autenticação, então campo extra
 *         que escape do DTO vira vazamento.
 */
import { z } from 'zod';

export const respostaLiveSchema = z
  .object({
    status: z.literal('ok'),
    uptime_seconds: z.number().int().nonnegative(),
  })
  .strict();

export type RespostaLive = z.infer<typeof respostaLiveSchema>;

export const dependenciaSchema = z
  .object({
    nome: z.enum(['postgres', 'mongodb']),
    estado: z.enum(['up', 'down']),
    duracao_ms: z.number().int().nonnegative(),
    // Categoria fixa, nunca a mensagem do driver: ela traz host, porta e usuário.
    motivo: z.enum(['timeout', 'indisponivel', 'erro_interno']).optional(),
  })
  .strict();

export const respostaProntaSchema = z
  .object({
    status: z.literal('ready'),
    dependencias: z.array(dependenciaSchema),
  })
  .strict();

export type RespostaPronta = z.infer<typeof respostaProntaSchema>;
