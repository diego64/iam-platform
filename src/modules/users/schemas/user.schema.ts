/**
 * Responsabilidade: os schemas Zod das rotas de usuário (borda HTTP).
 * Consumido por: `routes/` e `controllers/` desta SPEC.
 * Regras:
 *  - `.strict()` em bodies/params/query — campo extra ⇒ 400 (anti mass-assignment: barra
 *    tentativa de setar `status`/`roles` direto no corpo).
 *  - Reusa `senhaForte` da 009: a força da senha é uma regra só, definida uma vez.
 */
import { z } from 'zod';
import { senhaForte } from '../../password/schemas/senha-forte.js';

export const criarUsuarioBody = z
  .object({
    email: z.string().trim().email().max(254),
    senha: senhaForte,
  })
  .strict();

export const atualizarUsuarioBody = z
  .object({
    email: z.string().trim().email().max(254),
  })
  .strict();

export const idParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const listarUsuariosQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(['active', 'blocked']).optional(),
  })
  .strict();

export type CriarUsuarioBody = z.infer<typeof criarUsuarioBody>;
export type AtualizarUsuarioBody = z.infer<typeof atualizarUsuarioBody>;
export type IdParams = z.infer<typeof idParams>;
export type ListarUsuariosQuery = z.infer<typeof listarUsuariosQuery>;
