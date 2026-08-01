/**
 * Cobre a geração do par Ed25519: o JWK público bate com o contrato (kty/crv/use/alg, kid
 * UUIDv7, sem `d`) e a privada em DER forma par com a pública — um token assinado com uma
 * verifica com a outra.
 */
import { describe, expect, it } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { SignJWT, importJWK, jwtVerify } from 'jose';
import { gerarParEd25519 } from '../../../../src/modules/jwks/services/key-factory.js';

const FORMATO_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('gerarParEd25519', () => {
  it('monta o JWK público no contrato RFC 7517 (OKP/Ed25519) sem privada', async () => {
    const { kid, publicJwk } = await gerarParEd25519();

    expect(publicJwk).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      kid,
      use: 'sig',
      alg: 'EdDSA',
    });
    expect(publicJwk.x).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(kid).toMatch(FORMATO_V7);
    expect(publicJwk).not.toHaveProperty('d');
  });

  it('gera kids distintos a cada chamada', async () => {
    const [a, b] = await Promise.all([gerarParEd25519(), gerarParEd25519()]);
    expect(a.kid).not.toBe(b.kid);
  });

  it('a privada em DER forma par com a pública: assina com uma, verifica com a outra', async () => {
    const { publicJwk, privateKeyDer } = await gerarParEd25519();

    const privada = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
    const token = await new SignJWT({ scope: 'teste' })
      .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid })
      .sign(privada);

    const publica = await importJWK(publicJwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, publica, { algorithms: ['EdDSA'] });

    expect(protectedHeader.kid).toBe(publicJwk.kid);
    expect(payload.scope).toBe('teste');
  });
});
