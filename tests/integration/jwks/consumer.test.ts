/**
 * Cobre o cenário de consumidor de ponta a ponta: o app publica o JWK Set, o token é
 * assinado pela chave active e um consumidor que conhece SÓ a resposta do endpoint (sem
 * acesso ao IdP) consegue validar o token offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { construirApp } from '../../../src/app.js';
import {
  criarRepositorioJwks,
  type RepositorioJwks,
} from '../../../src/modules/jwks/repositories/jwks.repository.js';
import {
  criarJwksService,
  type JwksService,
} from '../../../src/modules/jwks/services/jwks.service.js';
import { garantirChaveDeBootstrap } from '../../../src/modules/jwks/services/bootstrap-key.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparJwks, recriarSchemaJwks } from './schema.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

let pool: Pool;
let repo: RepositorioJwks;
let service: JwksService;
let app: FastifyInstance;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchemaJwks(pool);
  await limparJwks(pool);
  repo = criarRepositorioJwks(pool);
  await garantirChaveDeBootstrap({
    repo,
    masterKey: MASTER,
    logger: criarLogger({ nivel: 'fatal' }),
  });

  service = criarJwksService({ repo, masterKey: MASTER, graceMs: 900_000, cacheTtlMs: 300_000 });
  await service.iniciar();
  app = await construirApp(envDeIntegracao(), { jwks: service });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('consumidor valida token usando apenas o endpoint JWKS', () => {
  it('assina com a active e verifica com o JWK Set publicado', async () => {
    // Token emitido pelo IdP (assina com a chave active).
    const ativa = await service.obterChaveAtiva();
    const token = await new SignJWT({ scope: 'leitura' })
      .setProtectedHeader({ alg: 'EdDSA', kid: ativa.kid })
      .setIssuedAt()
      .sign(ativa.privateKey.usar());

    // Consumidor: conhece só o que o endpoint devolve.
    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const jwks = resposta.json<Parameters<typeof createLocalJWKSet>[0]>();
    const conjuntoDoConsumidor = createLocalJWKSet(jwks);

    const { payload, protectedHeader } = await jwtVerify(token, conjuntoDoConsumidor, {
      algorithms: ['EdDSA'],
    });
    expect(protectedHeader.kid).toBe(ativa.kid);
    expect(payload.scope).toBe('leitura');
  });

  it('a resposta publicada não contém material privado', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(JSON.stringify(resposta.json())).not.toMatch(/"d"\s*:/);
    expect(resposta.headers['cache-control']).toBe('public, max-age=300');
  });
});
