/**
 * Responsabilidade: schemas Zod da borda HTTP de clientes de API.
 * Regras: importado só por routes/ e controllers/. `.strict()` na entrada e na saída — a
 * resposta estrita é a garantia de contrato de que nenhum campo de segredo escapa: um
 * `secret_hash` acidental quebra o teste em vez de vazar.
 */
import { z } from 'zod';

/**
 * Escopo no formato `recurso:acao`. O curinga `*` não casa aqui de propósito: além de ser
 * recusado pelo resolvedor, o formato já o exclui — duas barreiras, porque conceder o
 * curinga a um cliente seria o pior erro possível desta superfície.
 */
const ESCOPO = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/);

const GRANT = z.enum(['client_credentials', 'password', 'refresh_token']);
const STATUS = z.enum(['active', 'disabled', 'deleted']);
const TTL = z.number().int().min(60).max(3600);

export const idParams = z.object({ id: z.string().uuid() }).strict();
export type IdParams = z.infer<typeof idParams>;

export const listarClientesQuery = z
  .object({
    status: STATUS.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListarClientesQuery = z.infer<typeof listarClientesQuery>;

export const criarClienteBody = z
  .object({
    name: z.string().min(2).max(128),
    description: z.string().max(256).optional(),
    scopes: z.array(ESCOPO).min(1).max(100),
    grant_types: z.array(GRANT).min(1).default(['client_credentials']),
    access_token_ttl_seconds: TTL.optional(),
  })
  .strict();
export type CriarClienteBody = z.infer<typeof criarClienteBody>;

/** Campos cuja alteração concede privilégio — a rota exige `superadmin` para eles. */
export const CAMPOS_PRIVILEGIADOS = ['scopes', 'grant_types', 'access_token_ttl_seconds'] as const;

export const atualizarClienteBody = z
  .object({
    // Operacionais: exigem `clients:write`.
    name: z.string().min(2).max(128).optional(),
    description: z.string().max(256).nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    // Privilegiados: exigem o papel `superadmin`.
    scopes: z.array(ESCOPO).min(1).max(100).optional(),
    grant_types: z.array(GRANT).min(1).optional(),
    access_token_ttl_seconds: TTL.nullable().optional(),
  })
  .strict()
  .refine((corpo) => Object.keys(corpo).length > 0, { message: 'corpo vazio' });
export type AtualizarClienteBody = z.infer<typeof atualizarClienteBody>;

export const rotacionarSegredoBody = z
  .object({
    // Teto de 7 dias: além disso a segunda via deixa de ser janela de deploy.
    overlap_seconds: z.number().int().min(0).max(604_800).optional(),
  })
  .strict();
export type RotacionarSegredoBody = z.infer<typeof rotacionarSegredoBody>;

export const clienteDto = z
  .object({
    id: z.string().uuid(),
    client_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: STATUS,
    scopes: z.array(z.string()),
    grant_types: z.array(GRANT),
    access_token_ttl_seconds: z.number().int().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    last_used_at: z.string().datetime().nullable(),
    secret_rotated_at: z.string().datetime().nullable(),
    previous_secret_expires_at: z.string().datetime().nullable(),
  })
  .strict();

/** O cliente recém-criado — o único lugar, junto da rotação, em que o segredo aparece. */
export const respostaClienteCriado = clienteDto.extend({ client_secret: z.string() }).strict();

export const respostaListaDeClientes = z
  .object({ items: z.array(clienteDto), total: z.number().int().nonnegative() })
  .strict();

export const respostaSegredoRotacionado = z
  .object({
    client_id: z.string(),
    client_secret: z.string(),
    secret_rotated_at: z.string().datetime(),
    previous_secret_expires_at: z.string().datetime().nullable(),
  })
  .strict();
