/**
 * Responsabilidade: schemas Zod da borda HTTP da trilha.
 * Regras: importado só por routes/ e controllers/. `.strict()` em toda entrada — filtro com
 * campo extra é 400, não filtro silenciosamente ignorado, que produziria uma resposta
 * "completa" para quem pediu um recorte.
 */
import { z } from 'zod';
import { MOTIVOS_DE_EVENTO, TIPOS_DE_EVENTO } from '../constants/event-types.js';

const LIMITE_MAXIMO = 200;

/**
 * Filtro da listagem.
 *
 * `actor_id`/`target_id` só aceitam UUID: a trilha não é consultável por e-mail, e deixar
 * um campo de texto livre aqui transformaria a leitura de auditoria num oráculo de
 * enumeração para quem tem `audit:read`.
 */
export const listarEventosQuery = z
  .object({
    type: z.enum(TIPOS_DE_EVENTO).optional(),
    actor_id: z.string().uuid().optional(),
    target_id: z.string().uuid().optional(),
    outcome: z.enum(['success', 'failure']).optional(),
    de: z.coerce.date().optional(),
    ate: z.coerce.date().optional(),
    /** Posição a partir da qual continuar — o `proximo_cursor` da página anterior. */
    cursor: z.coerce.number().int().min(0).optional(),
    limite: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(50),
  })
  .strict();
export type ListarEventosQuery = z.infer<typeof listarEventosQuery>;

export const eventoParams = z.object({ seq: z.coerce.number().int().min(1) }).strict();
export type EventoParams = z.infer<typeof eventoParams>;

export const integridadeQuery = z
  .object({
    de: z.coerce.number().int().min(1).default(1),
    ate: z.coerce.number().int().min(1).optional(),
  })
  .strict()
  .refine((faixa) => faixa.ate === undefined || faixa.ate >= faixa.de, {
    message: 'ate deve ser maior ou igual a de',
  });
export type IntegridadeQuery = z.infer<typeof integridadeQuery>;

const atorResposta = z.object({
  id: z.string().nullable(),
  type: z.enum(['user', 'client', 'system']),
  ip: z.string().optional(),
  user_agent: z.string().optional(),
});

const alvoResposta = z
  .object({ id: z.string(), type: z.enum(['user', 'role', 'client', 'key', 'session']) })
  .nullable();

/**
 * O evento como a API o devolve.
 *
 * `prev_hash` não entra: é redundante com o `hash` do item anterior e só induziria o
 * consumidor a tentar validar a cadeia com uma página parcial. Quem quer verificar usa a
 * rota de integridade, que percorre a faixa inteira.
 */
export const eventoResposta = z.object({
  seq: z.number().int(),
  event_id: z.string(),
  type: z.enum(TIPOS_DE_EVENTO),
  occurred_at: z.string(),
  actor: atorResposta,
  target: alvoResposta,
  outcome: z.enum(['success', 'failure']),
  reason: z.enum(MOTIVOS_DE_EVENTO).nullable(),
  subject_hint: z.string().nullable(),
  metadata: z.record(z.unknown()),
  request_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  hash: z.string(),
});

/** O detalhe acrescenta o elo anterior: aqui não há página parcial que confunda. */
export const eventoDetalheResposta = eventoResposta.extend({ prev_hash: z.string() });

export const listaDeEventosResposta = z.object({
  itens: z.array(eventoResposta),
  proximo_cursor: z.number().int().nullable(),
  tem_mais: z.boolean(),
});

export const relatorioDeIntegridadeResposta = z.object({
  integra: z.boolean(),
  de: z.number().int(),
  ate: z.number().int(),
  verificados: z.number().int(),
  primeira_quebra: z
    .object({
      seq: z.number().int(),
      motivo: z.enum(['hash-divergente', 'elo-quebrado', 'seq-faltante', 'checkpoint-divergente']),
    })
    .nullable(),
  checkpoint_conferido: z
    .object({ seq: z.number().int(), hash: z.string(), confere: z.boolean() })
    .nullable(),
});
