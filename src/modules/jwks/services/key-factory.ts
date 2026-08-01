/**
 * Responsabilidade: gerar um par Ed25519 e montar o JWK público (kty OKP, use sig, EdDSA).
 * Consumido por: o script de bootstrap e, no futuro, a rotação de chaves.
 * Regras:
 *  - O `kid` é UUIDv7 (ordenável por tempo). A privada sai em PKCS#8 DER, pronta para o
 *    envelope de cifra — nunca é logada nem persistida em claro.
 *  - O JWK público carrega só `x` (material público); jamais o `d`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK } from 'jose';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';
import type { JwkPublica } from '../types/jwks.types.js';

export interface ParDeChaves {
  readonly kid: string;
  readonly publicJwk: JwkPublica;
  /** Privada em PKCS#8 DER — o chamador cifra antes de persistir. */
  readonly privateKeyDer: Buffer;
}

/** Gera um novo par Ed25519 com `kid` UUIDv7 e o JWK público montado. */
export async function gerarParEd25519(): Promise<ParDeChaves> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const kid = uuidv7();

  // exportJWK devolve { kty:'OKP', crv:'Ed25519', x }. Os campos de uso viajam à parte.
  const base = await exportJWK(publicKey);
  if (base.x === undefined) {
    throw new Error('exportação de JWK Ed25519 sem componente público x');
  }

  const publicJwk: JwkPublica = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: base.x,
    kid,
    use: 'sig',
    alg: 'EdDSA',
  };

  return { kid, publicJwk, privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }) };
}
