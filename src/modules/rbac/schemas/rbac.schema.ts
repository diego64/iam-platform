/**
 * Responsabilidade: schemas Zod da borda HTTP do RBAC.
 * Regras: importado só por routes/ e controllers/. `.strict()` nos corpos — campo extra na
 * entrada é 400. Respostas modelam exatamente o DTO (snake_case), sem `is_system` derivado
 * de coluna nova vazar sozinho.
 */
import { z } from 'zod';

const NOME_DE_PAPEL = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);
// Permissão no formato recurso:acao (a ação pode ser o curinga `*`). O curinga global `*`
// não casa aqui de propósito: ele é semeado, nunca criado pela API.
const NOME_DE_PERMISSAO = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_-]+:([a-z0-9_-]+|\*)$/);

export const paginacaoQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type PaginacaoQuery = z.infer<typeof paginacaoQuery>;

export const idParams = z.object({ id: z.string().uuid() }).strict();
export type IdParams = z.infer<typeof idParams>;

export const roleComPermissaoParams = z
  .object({ id: z.string().uuid(), permId: z.string().uuid() })
  .strict();
export type RoleComPermissaoParams = z.infer<typeof roleComPermissaoParams>;

export const userComPapelParams = z
  .object({ id: z.string().uuid(), roleId: z.string().uuid() })
  .strict();
export type UserComPapelParams = z.infer<typeof userComPapelParams>;

export const criarPapelBody = z
  .object({ name: NOME_DE_PAPEL, description: z.string().max(256).optional() })
  .strict();
export type CriarPapelBody = z.infer<typeof criarPapelBody>;

export const atualizarPapelBody = z
  .object({
    name: NOME_DE_PAPEL.optional(),
    description: z.string().max(256).nullable().optional(),
  })
  .strict();
export type AtualizarPapelBody = z.infer<typeof atualizarPapelBody>;

export const criarPermissaoBody = z
  .object({ name: NOME_DE_PERMISSAO, description: z.string().max(256).optional() })
  .strict();
export type CriarPermissaoBody = z.infer<typeof criarPermissaoBody>;

export const associarPermissoesBody = z
  .object({ permission_ids: z.array(z.string().uuid()).min(1).max(100) })
  .strict();
export type AssociarPermissoesBody = z.infer<typeof associarPermissoesBody>;

export const atribuirPapeisBody = z
  .object({ role_ids: z.array(z.string().uuid()).min(1).max(50) })
  .strict();
export type AtribuirPapeisBody = z.infer<typeof atribuirPapeisBody>;

// Respostas (não-strict: o Zod descarta chaves extras na serialização).
const papelDTO = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
});

export const respostaPapel = papelDTO;
export const respostaPapelDetalhe = papelDTO.extend({ permissions: z.array(z.string()) });
export const respostaListaPapeis = z.object({ items: z.array(papelDTO), total: z.number().int() });

const permissaoDTO = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
});

export const respostaPermissao = permissaoDTO;
export const respostaListaPermissoes = z.object({
  items: z.array(permissaoDTO),
  total: z.number().int(),
});

export const respostaPapeisDoUsuario = z.object({
  user_id: z.string().uuid(),
  roles: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
