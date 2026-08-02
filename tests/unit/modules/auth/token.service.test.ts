/**
 * Cobre a emissão do access token: claims completos (sub/jti/iat/exp/iss/aud/scope/roles),
 * header com kid e alg EdDSA, e verificação real com a chave pública correspondente.
 */
import { describe, expect, it } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { importJWK, jwtVerify, decodeProtectedHeader } from 'jose';
import { criarTokenService } from '../../../../src/modules/auth/services/token.service.js';
import { gerarParEd25519 } from '../../../../src/modules/jwks/services/key-factory.js';
import { ChavePrivada } from '../../../../src/shared/crypto/private-key.js';
import type { JwkPublica } from '../../../../src/modules/jwks/types/jwks.types.js';

const CONFIG = { emissor: 'https://iam.example.com', audiencia: 'iam-clients', ttlSegundos: 900 };

/** Cria um TokenService com uma chave real e devolve também o JWK público para verificar. */
async function montar(): Promise<{
  service: ReturnType<typeof criarTokenService>;
  publicJwk: JwkPublica;
  kid: string;
}> {
  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  const keyObject = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  const jwks = {
    obterChaveAtiva: () =>
      Promise.resolve({
        kid,
        algorithm: 'EdDSA' as const,
        privateKey: new ChavePrivada(keyObject),
      }),
  };
  return { service: criarTokenService(jwks, CONFIG), publicJwk, kid };
}

describe('TokenService.emitir', () => {
  it('assina um JWT EdDSA com header kid e todos os claims', async () => {
    const { service, publicJwk, kid } = await montar();

    const emitido = await service.emitir({
      sub: 'user-1',
      roles: ['admin'],
      permissions: ['users:read', 'users:delete'],
      scope: 'leitura',
    });

    expect(decodeProtectedHeader(emitido.token)).toMatchObject({ alg: 'EdDSA', kid });

    const publica = await importJWK(publicJwk, 'EdDSA');
    const { payload } = await jwtVerify(emitido.token, publica, {
      algorithms: ['EdDSA'],
      issuer: CONFIG.emissor,
      audience: CONFIG.audiencia,
    });

    expect(payload.sub).toBe('user-1');
    expect(payload.jti).toBe(emitido.jti);
    expect(payload.scope).toBe('leitura');
    expect(payload.roles).toEqual(['admin']);
    expect(payload.perm).toEqual(['users:read', 'users:delete']);
    expect(payload.iss).toBe(CONFIG.emissor);
    expect(payload.aud).toBe(CONFIG.audiencia);
    expect(payload.exp).toBe(Math.floor(emitido.expiraEm.getTime() / 1000));
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(CONFIG.ttlSegundos);
  });

  it('gera jti distinto a cada emissão', async () => {
    const { service } = await montar();
    const a = await service.emitir({ sub: 'u', roles: [], permissions: [], scope: '' });
    const b = await service.emitir({ sub: 'u', roles: [], permissions: [], scope: '' });
    expect(a.jti).not.toBe(b.jti);
  });
});
