/**
 * Responsabilidade: schemas Zod da borda HTTP do painel.
 * Regras: importado só por routes/ e controllers/. `.strict()` em toda entrada; `:id` é
 * sempre UUID, porque a rota administrativa nunca busca usuário por outro identificador.
 */
import { z } from 'zod';

export const usuarioParams = z.object({ id: z.string().uuid() }).strict();
export type UsuarioParams = z.infer<typeof usuarioParams>;

export const sessaoParams = z
  .object({ id: z.string().uuid(), sessionId: z.string().uuid() })
  .strict();
export type SessaoParams = z.infer<typeof sessaoParams>;

const sessaoResposta = z.object({
  session_id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  ip: z.string().optional(),
  user_agent: z.string().optional(),
  last_seen_at: z.string().optional(),
});

export const visaoGeralResposta = z.object({
  apurado_em: z.string(),
  cache: z.enum(['hit', 'miss']),
  parcial: z.boolean(),
  usuarios: z.object({
    active: z.number().int(),
    blocked: z.number().int(),
    total: z.number().int(),
  }),
  sessoes_ativas: z.number().int().nullable(),
  logins_24h: z.object({ sucesso: z.number().int(), falha: z.number().int() }).nullable(),
  clientes_ativos: z.number().int().nullable(),
  chave_ativa: z.object({ kid: z.string(), idade_dias: z.number().int() }).nullable(),
});

export const fichaDeUsuarioResposta = z.object({
  parcial: z.boolean(),
  perfil: z.object({
    id: z.string(),
    email: z.string(),
    status: z.enum(['active', 'blocked']),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  papeis: z
    .array(z.object({ id: z.string(), name: z.string(), is_system: z.boolean() }))
    .nullable(),
  permissoes: z.array(z.string()).nullable(),
  senha: z.object({ alterada_em: z.string().nullable() }).nullable(),
  sessoes: z.array(sessaoResposta).nullable(),
  eventos: z
    .array(
      z.object({
        seq: z.number().int(),
        type: z.string(),
        occurred_at: z.string(),
        outcome: z.string(),
      }),
    )
    .nullable(),
});

export const listaDeSessoesResposta = z.object({
  itens: z.array(sessaoResposta),
  total: z.number().int(),
});

export const revogacaoEmMassaResposta = z.object({ revogadas: z.number().int() });
