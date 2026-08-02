/**
 * Cobre o fail-closed do boot contra PostgreSQL real: com uma chave active cifrada por uma
 * MASTER_KEY, iniciar() só resolve com a chave correta. Chave errada ou ausente ⇒ rejeita —
 * o processo não subiria servindo tokens não-verificáveis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import {
  criarRepositorioJwks,
  type RepositorioJwks,
} from '../../../src/modules/jwks/repositories/jwks.repository.js';
import { criarJwksService } from '../../../src/modules/jwks/services/jwks.service.js';
import { gerarParEd25519 } from '../../../src/modules/jwks/services/key-factory.js';
import { cifrarPrivada } from '../../../src/shared/crypto/key-envelope.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparJwks, recriarSchemaJwks } from './schema.js';

const MASTER_CORRETA = 'master-key-correta-com-mais-de-32-bytes';
const MASTER_ERRADA = 'master-key-errada-com-mais-de-32-bytesx';
const CONFIG_BASE = { cacheTtlMs: 300_000 };

let pool: Pool;
let repo: RepositorioJwks;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchemaJwks(pool);
  repo = criarRepositorioJwks(pool);
});

beforeEach(async () => {
  await limparJwks(pool);
  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  await repo.inserir({
    kid,
    algorithm: 'EdDSA',
    publicJwk,
    privateKeyEnc: cifrarPrivada(privateKeyDer, MASTER_CORRETA),
    status: 'active',
  });
});

afterAll(async () => {
  await pool.end();
});

it('rejeita iniciar com a MASTER_KEY errada', async () => {
  const service = criarJwksService({ repo, masterKey: MASTER_ERRADA, ...CONFIG_BASE });
  await expect(service.iniciar()).rejects.toThrow();
});

it('rejeita iniciar sem MASTER_KEY quando há chave active', async () => {
  const service = criarJwksService({ repo, ...CONFIG_BASE });
  await expect(service.iniciar()).rejects.toThrow();
});

describe('MASTER_KEY correta', () => {
  it('inicia e a chave active assina um token verificável pelo conjunto público', async () => {
    const service = criarJwksService({ repo, masterKey: MASTER_CORRETA, ...CONFIG_BASE });
    await expect(service.iniciar()).resolves.toBeUndefined();

    const ativa = await service.obterChaveAtiva();
    const token = await new SignJWT({ scope: 'x' })
      .setProtectedHeader({ alg: 'EdDSA', kid: ativa.kid })
      .sign(ativa.privateKey.usar());

    const verificacao = await service.obterConjuntoDeVerificacao();
    const { protectedHeader } = await jwtVerify(token, verificacao, { algorithms: ['EdDSA'] });
    expect(protectedHeader.kid).toBe(ativa.kid);
  });
});
