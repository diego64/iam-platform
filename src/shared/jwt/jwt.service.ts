/**
 * Responsabilidade: assinar e verificar JWTs com jose.
 * Regras:
 *  - Assinatura: EdDSA com a chave ativa (jwks.service), header {alg: 'EdDSA', kid}
 *  - Verificação: algorithms fixo em ['EdDSA'], issuer e audience obrigatórios
 *  - Claims: sub, jti (UUIDv7), iat, exp, iss, aud, scope, roles
 *  - Jamais aceitar 'alg: none' ou chave simétrica
 */
export interface CargaDoToken {
  sub: string;
  jti: string;
  scope: string;
  roles: string[];
}

