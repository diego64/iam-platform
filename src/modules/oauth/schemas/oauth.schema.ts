/**
 * Responsabilidade: schemas Zod da borda HTTP do endpoint de token.
 * Regras:
 *  - Importado só por `routes/` e `controllers/`.
 *  - **Sem `.strict()`**, ao contrário do resto da plataforma: a RFC 6749 §3.2 manda ignorar
 *    parâmetro desconhecido, e clientes prontos mandam extras (`audience`, `resource`).
 *    Recusá-los quebraria interoperabilidade com biblioteca cliente que não dá para editar.
 *  - `grant_type` é texto livre aqui e é decidido no serviço: um valor desconhecido precisa
 *    virar `unsupported_grant_type`, e uma união discriminada devolveria erro de validação.
 *  - `username` não é validado como e-mail de propósito: formato errado deve falhar como
 *    credencial inválida, não com um código distinto que separe "não é e-mail" de "não
 *    existe".
 */
import { z } from 'zod';

/** Nome de permissão do catálogo do RBAC — o mesmo vocabulário dos escopos de cliente. */
const escopo = z.string().regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/);

/** `scope` chega como texto separado por espaço e sai como lista validada. */
const escoposSolicitados = z
  .string()
  .max(2048)
  .transform((valor) => valor.split(' ').filter((parte) => parte.length > 0))
  .pipe(z.array(escopo).max(100))
  .optional();

export const corpoDeToken = z.object({
  grant_type: z.string().min(1).max(64),
  scope: escoposSolicitados,
  client_id: z.string().max(128).optional(),
  client_secret: z.string().max(256).optional(),
  username: z.string().max(254).optional(),
  password: z.string().max(128).optional(),
  refresh_token: z.string().max(512).optional(),
});
export type CorpoDeToken = z.infer<typeof corpoDeToken>;

export const respostaDeToken = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: z.string(),
    refresh_token: z.string().optional(),
  })
  .strict();

export const metadadosDoServidor = z
  .object({
    issuer: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    grant_types_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    response_types_supported: z.array(z.string()),
    scopes_supported: z.array(z.string()),
  })
  .strict();

/** Erro no formato da RFC 6749 §5.2 — declarado para o OpenAPI, não para validar entrada. */
export const erroDeOAuth = z
  .object({
    error: z.string(),
    error_description: z.string(),
  })
  .strict();
