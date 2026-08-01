/**
 * Contrato: a resposta real de /.well-known/jwks.json bate com openapi/openapi.yaml — o JWK
 * traz exatamente kty/crv/x/kid/use/alg, o Cache-Control está presente e o campo `d` jamais
 * aparece. Sem isto, o consumidor gera cliente a partir do contrato e descobre a divergência
 * em produção.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarEnv } from '../../src/config/env.js';
import { gerarParEd25519 } from '../../src/modules/jwks/services/key-factory.js';
import type { JwksService } from '../../src/modules/jwks/services/jwks.service.js';
import type { JwkPublica } from '../../src/modules/jwks/types/jwks.types.js';

let app: FastifyInstance;
let publicJwk: JwkPublica;

/** Serviço de chaves fixo, sem banco — só publica um JWK público conhecido. */
function jwksFalso(jwk: JwkPublica): JwksService {
  return {
    iniciar: () => Promise.resolve(),
    obterChaveAtiva: () => Promise.reject(new Error('não usado no contrato')),
    obterConjuntoDeVerificacao: () => Promise.reject(new Error('não usado no contrato')),
    obterConjuntoPublico: () => Promise.resolve({ keys: [jwk] }),
    invalidar: () => undefined,
  };
}

beforeAll(async () => {
  ({ publicJwk } = await gerarParEd25519());
  app = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
    { jwks: jwksFalso(publicJwk) },
  );
});

afterAll(async () => {
  await app.close();
});

function documentoOpenApi(): string {
  return readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');
}

describe('contrato /.well-known/jwks.json', () => {
  it('a rota está declarada no openapi.yaml e no Swagger servido', () => {
    expect(documentoOpenApi()).toContain('/.well-known/jwks.json:');
    const servido = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(servido.paths)).toContain('/.well-known/jwks.json');
  });

  it('cada JWK traz exatamente os campos do contrato, e nunca o `d`', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const corpo = resposta.json<{ keys: Record<string, unknown>[] }>();

    expect(resposta.statusCode).toBe(200);
    expect(corpo.keys).toHaveLength(1);
    const jwk = corpo.keys[0];
    expect(Object.keys(jwk ?? {}).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
    expect(jwk).not.toHaveProperty('d');
  });

  it('serve Cache-Control público de 5 minutos', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(resposta.headers['cache-control']).toBe('public, max-age=300');
  });

  it('a resposta inteira, serializada, jamais contém o campo `d`', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(JSON.stringify(resposta.json())).not.toMatch(/"d"\s*:/);
  });
});
