/**
 * Responsabilidade: schemas Zod da borda HTTP dos eventos de segurança.
 * Regras:
 *  - Importado só por `routes/` e `controllers/`. `.strict()` na resposta — um campo com
 *    identificador em claro quebra o contrato em vez de vazar.
 *  - A consulta exige recorte por tempo, com default de 24 h: sem ele, uma listagem varreria
 *    a coleção inteira, e o custo apareceria justamente no dia de maior volume.
 */
import { z } from 'zod';
import { REGRAS, SEVERIDADES } from '../constants/regras.js';

/** Teto da janela de consulta. Acima disso, a leitura deixa de ser barata. */
export const JANELA_MAXIMA_MS = 30 * 24 * 60 * 60 * 1000;

export const consultaDeEventos = z
  .object({
    regra: z.enum(REGRAS).optional(),
    severidade: z.enum(SEVERIDADES).optional(),
    desde: z.coerce.date().optional(),
    ate: z.coerce.date().optional(),
    // A pista vem de outro evento ou da trilha — é como se investiga um sujeito.
    pista: z.string().length(64).optional(),
    limite: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict()
  .refine((c) => c.desde === undefined || c.ate === undefined || c.desde <= c.ate, {
    message: 'desde precisa ser anterior a ate',
  })
  .refine(
    (c) =>
      c.desde === undefined ||
      c.ate === undefined ||
      c.ate.getTime() - c.desde.getTime() <= JANELA_MAXIMA_MS,
    { message: 'janela maior que o teto de consulta' },
  );
export type ConsultaDeEventos = z.infer<typeof consultaDeEventos>;

export const parametroDeEvento = z.object({ id: z.string().min(1).max(64) });

export const eventoDeSegurancaDto = z
  .object({
    id: z.string(),
    regra: z.enum(REGRAS),
    severidade: z.enum(SEVERIDADES),
    sujeito: z
      .object({
        tipo: z.enum(['conta', 'ip', 'cliente', 'usuario']),
        pista: z.string(),
      })
      .strict(),
    ocorrencias: z.number().int().positive(),
    janela_ms: z.number().int().nonnegative(),
    primeira_em: z.string().datetime(),
    ultima_em: z.string().datetime(),
    detectado_em: z.string().datetime(),
    trace_id: z.string().nullable(),
    metadata: z.record(z.string()),
  })
  .strict();

export const listaDeEventos = z
  .object({
    items: z.array(eventoDeSegurancaDto),
    proximo_cursor: z.string().nullable(),
  })
  .strict();
