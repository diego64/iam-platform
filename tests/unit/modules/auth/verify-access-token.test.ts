/**
 * Cobre o middleware verificarAccessToken: aceita token válido e popula request.usuario;
 * rejeita alg forjado (HS256), token expirado, aud/iss errados, jti revogado e falha na
 * denylist (fail closed) — todos com 401 problem+json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { createPrivateKey } from 'node:crypto';
import { SignJWT, createLocalJWKSet } from 'jose';
import {
  criarVerificadorDeAccessToken,
  type DependenciasDeVerificacao,
} from '../../../../src/modules/auth/middleware/verify-access-token.js';
import { gerarParEd25519 } from '../../../../src/modules/jwks/services/key-factory.js';
import type { JwkPublica } from '../../../../src/modules/jwks/types/jwks.types.js';

const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';

let publicJwk: JwkPublica;
let assinar: (
  claims: Record<string, unknown>,
  opcoes?: { exp?: string | number; iss?: string; aud?: string },
) => Promise<string>;
let revogados: Set<string>;
let denylistQuebrada: boolean;
let app: FastifyInstance;

function deps(): DependenciasDeVerificacao {
  return {
    jwks: {
      obterConjuntoDeVerificacao: () => Promise.resolve(createLocalJWKSet({ keys: [publicJwk] })),
    },
    denylist: {
      revogar: () => Promise.resolve(),
      estaRevogado: (jti: string) =>
        denylistQuebrada
          ? Promise.reject(new Error('mongo fora'))
          : Promise.resolve(revogados.has(jti)),
    },
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  };
}

beforeEach(async () => {
  const { kid, publicJwk: pub, privateKeyDer } = await gerarParEd25519();
  publicJwk = pub;
  const chave = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  assinar = (claims, opcoes = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(typeof claims.sub === 'string' ? claims.sub : 'user-1')
      .setJti(typeof claims.jti === 'string' ? claims.jti : 'jti-1')
      .setIssuedAt()
      .setExpirationTime(opcoes.exp ?? '15m')
      .setIssuer(opcoes.iss ?? EMISSOR)
      .setAudience(opcoes.aud ?? AUDIENCIA)
      .sign(chave);
  revogados = new Set();
  denylistQuebrada = false;

  app = Fastify({ logger: false });
  app.get('/protegido', { preHandler: criarVerificadorDeAccessToken(deps()) }, (req) => ({
    usuario: req.usuario,
  }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const pedir = (token?: string): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url: '/protegido',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe('verificarAccessToken', () => {
  it('aceita token válido e popula request.usuario', async () => {
    const token = await assinar({ sub: 'user-1', jti: 'j1', scope: 'leitura', roles: ['admin'] });
    const res = await pedir(token);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ usuario: unknown }>().usuario).toEqual({
      id: 'user-1',
      roles: ['admin'],
      scope: 'leitura',
    });
  });

  it('rejeita ausência de Authorization', async () => {
    const res = await pedir();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejeita alg forjado (HS256)', async () => {
    // Token HS256 com o kid certo mas algoritmo simétrico: a verificação fixa em EdDSA barra.
    const forjado = await new SignJWT({ sub: 'x', jti: 'j' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(EMISSOR)
      .setAudience(AUDIENCIA)
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('segredo-simetrico-do-atacante-000000'));

    expect((await pedir(forjado)).statusCode).toBe(401);
  });

  it('rejeita token expirado', async () => {
    const token = await assinar(
      { sub: 'u', jti: 'j' },
      { exp: Math.floor(Date.now() / 1000) - 10 },
    );
    expect((await pedir(token)).statusCode).toBe(401);
  });

  it('rejeita audiência e emissor errados', async () => {
    const audErrada = await assinar({ sub: 'u', jti: 'j' }, { aud: 'outra' });
    const issErrado = await assinar({ sub: 'u', jti: 'j' }, { iss: 'https://malicioso' });
    expect((await pedir(audErrada)).statusCode).toBe(401);
    expect((await pedir(issErrado)).statusCode).toBe(401);
  });

  it('rejeita jti revogado com token-revoked', async () => {
    revogados.add('j-revogado');
    const token = await assinar({ sub: 'u', jti: 'j-revogado' });
    const res = await pedir(token);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ type: string }>().type).toContain('token-revoked');
  });

  it('fail closed: erro na denylist rejeita o token', async () => {
    denylistQuebrada = true;
    const token = await assinar({ sub: 'u', jti: 'j' });
    expect((await pedir(token)).statusCode).toBe(401);
  });
});
