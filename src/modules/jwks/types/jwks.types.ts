/**
 * Responsabilidade: os tipos do domínio JWKS, compartilhados entre repositório, serviço e
 * borda HTTP.
 * Regras: material público apenas — a privada nunca entra nestes tipos (ela vive cifrada
 * em `Buffer` no repositório e como `KeyObject` no serviço).
 */

/**
 * Estados do ciclo de vida de uma chave: `active` assina (uma só), `next` é a próxima já
 * publicada mas ainda sem assinar, `retired` só verifica dentro da janela de graça.
 */
export type StatusDaChave = 'active' | 'next' | 'retired';

/** Chave pública no formato JWK (RFC 7517) para Ed25519 (OKP). Nunca contém `d` (privada). */
export interface JwkPublica {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  /** Chave pública em base64url. */
  readonly x: string;
  readonly kid: string;
  readonly use: 'sig';
  readonly alg: 'EdDSA';
}

/** Linha da tabela `jwks` já mapeada para o domínio. */
export interface ChaveJwks {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly publicJwk: JwkPublica;
  readonly privateKeyEnc: Buffer;
  readonly status: StatusDaChave;
  readonly criadaEm: Date;
  readonly ativadaEm: Date | null;
  readonly aposentadaEm: Date | null;
}
