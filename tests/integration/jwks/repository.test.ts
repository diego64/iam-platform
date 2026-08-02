/**
 * Cobre o repositório de chaves contra PostgreSQL real: o índice único parcial que impede
 * uma segunda chave `active`, o round-trip de `public_jwk` (JSONB) e `private_key_enc`
 * (BYTEA), e a janela de graça em `listarElegiveis` (retired dentro entra, fora sai).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioJwks,
  type EntradaDeChave,
  type RepositorioJwks,
} from '../../../src/modules/jwks/repositories/jwks.repository.js';
import { gerarParEd25519 } from '../../../src/modules/jwks/services/key-factory.js';
import { cifrarPrivada } from '../../../src/shared/crypto/key-envelope.js';
import type { StatusDaChave } from '../../../src/modules/jwks/types/jwks.types.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparJwks, recriarSchemaJwks } from './schema.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const GRACE_MS = 15 * 60 * 1000;

let pool: Pool;
let repo: RepositorioJwks;

async function novaEntrada(status: StatusDaChave): Promise<EntradaDeChave> {
  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  return {
    kid,
    algorithm: 'EdDSA',
    publicJwk,
    privateKeyEnc: cifrarPrivada(privateKeyDer, MASTER),
    status,
  };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchemaJwks(pool);
  repo = criarRepositorioJwks(pool);
});

beforeEach(async () => {
  await limparJwks(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('índices únicos parciais (jwks_one_active, jwks_one_next)', () => {
  it('impede uma segunda chave active', async () => {
    await repo.inserir(await novaEntrada('active'));
    await expect(repo.inserir(await novaEntrada('active'))).rejects.toMatchObject({
      code: '23505',
    });
  });

  // A rotação promove `next → active` sem escolher entre candidatas: só existe uma.
  it('impede uma segunda chave next', async () => {
    await repo.inserir(await novaEntrada('next'));
    await expect(repo.inserir(await novaEntrada('next'))).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('permite várias chaves retired — cada rotação aposenta mais uma', async () => {
    await repo.inserir(await novaEntrada('next'));
    await repo.inserir(await novaEntrada('retired'));
    await repo.inserir(await novaEntrada('retired'));
    expect(await repo.contarPorStatus()).toMatchObject({ next: 1, retired: 2 });
  });
});

describe('inserir e obterAtiva', () => {
  it('round-trip preserva o JWK público (JSONB) e a privada cifrada (BYTEA)', async () => {
    const entrada = await novaEntrada('active');
    const inserida = await repo.inserir(entrada);

    expect(inserida.ativadaEm).toBeInstanceOf(Date);
    const ativa = await repo.obterAtiva();
    expect(ativa?.kid).toBe(entrada.kid);
    expect(ativa?.publicJwk).toEqual(entrada.publicJwk);
    expect(Buffer.isBuffer(ativa?.privateKeyEnc)).toBe(true);
    expect(ativa?.privateKeyEnc.equals(entrada.privateKeyEnc)).toBe(true);
  });

  it('devolve null quando não há chave active', async () => {
    await repo.inserir(await novaEntrada('next'));
    expect(await repo.obterAtiva()).toBeNull();
  });
});

describe('listarElegiveis (janela de graça)', () => {
  it('inclui active e next; retired entra dentro da graça e sai fora dela', async () => {
    const agora = new Date();
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));

    // Retired DENTRO da graça: aposentada há 5 min.
    const dentro = await repo.inserir(await novaEntrada('retired'));
    await pool.query('UPDATE jwks SET retired_at = $2 WHERE kid = $1', [
      dentro.kid,
      new Date(agora.getTime() - 5 * 60 * 1000),
    ]);

    // Retired FORA da graça: aposentada há 20 min.
    const fora = await repo.inserir(await novaEntrada('retired'));
    await pool.query('UPDATE jwks SET retired_at = $2 WHERE kid = $1', [
      fora.kid,
      new Date(agora.getTime() - 20 * 60 * 1000),
    ]);

    const elegiveis = await repo.listarElegiveis(agora, GRACE_MS);
    const kids = elegiveis.map((c) => c.kid);

    expect(kids).toContain(dentro.kid);
    expect(kids).not.toContain(fora.kid);
    expect(kids).toHaveLength(3); // active + next + retired-dentro
  });
});
