/**
 * Responsabilidade: schema Zod da resposta do endpoint JWKS.
 * Regras: importado apenas por routes/ e controllers/. `.strict()` em tudo — a resposta é
 * pública e sem autenticação, então um campo extra (um `d` acidental) vira vazamento e o
 * serializer o rejeita.
 */
import { z } from 'zod';

export const jwkEd25519Schema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    /** Chave pública em base64url. */
    x: z.string().min(1),
    kid: z.string().min(1),
    use: z.literal('sig'),
    alg: z.literal('EdDSA'),
  })
  .strict();

export const jwksResponseSchema = z
  .object({
    // Sem `.min(1)`: uma instância recém-provisionada, ainda sem chave, responde 200 com
    // `keys: []` em vez de 500 — estado legítimo, não erro.
    keys: z.array(jwkEd25519Schema),
  })
  .strict();

export type JwksResponse = z.infer<typeof jwksResponseSchema>;
