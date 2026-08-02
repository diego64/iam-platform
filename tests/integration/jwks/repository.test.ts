/**
 * Cobre o repositório de chaves contra PostgreSQL real: os índices únicos parciais que
 * impedem uma segunda chave `active` ou `next`, o round-trip de `public_jwk` (JSONB) e
 * `private_key_enc` (BYTEA), a verificabilidade lida de `verifiable_until` (retired que
 * ainda verifica entra, o resto sai) e a listagem administrativa sem material de chave.
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

describe('listarElegiveis (verificabilidade materializada)', () => {
  /** Aposenta a chave gravando o instante em que ela deixa de verificar. */
  async function aposentar(kid: string, verificavelAte: Date): Promise<void> {
    await pool.query(
      "UPDATE jwks SET status = 'retired', retired_at = now(), verifiable_until = $2 WHERE kid = $1",
      [kid, verificavelAte],
    );
  }

  it('inclui active e next; retired entra enquanto verifica e sai depois', async () => {
    const agora = new Date();
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));

    const dentro = await repo.inserir(await novaEntrada('retired'));
    await aposentar(dentro.kid, new Date(agora.getTime() + 10 * 60 * 1000));

    const fora = await repo.inserir(await novaEntrada('retired'));
    await aposentar(fora.kid, new Date(agora.getTime() - 5 * 60 * 1000));

    const kids = (await repo.listarElegiveis()).map((c) => c.kid);

    expect(kids).toContain(dentro.kid);
    expect(kids).not.toContain(fora.kid);
    expect(kids).toHaveLength(3); // active + next + retired-que-ainda-verifica
  });

  it('devolve a chave já aposentada com verificavelAte preenchido', async () => {
    const agora = new Date();
    const chave = await repo.inserir(await novaEntrada('retired'));
    const ate = new Date(agora.getTime() + 60_000);
    await aposentar(chave.kid, ate);

    const elegivel = (await repo.listarElegiveis()).find((c) => c.kid === chave.kid);

    expect(elegivel?.verificavelAte?.toISOString()).toBe(ate.toISOString());
    expect(elegivel?.aposentadaEm).toBeInstanceOf(Date);
  });

  // Sem verifiable_until, uma chave marcada retired à mão não verifica nada — a coluna é o
  // único critério, e o default nulo é o mais seguro.
  it('exclui retired sem verifiable_until', async () => {
    const chave = await repo.inserir(await novaEntrada('retired'));

    const kids = (await repo.listarElegiveis()).map((c) => c.kid);

    expect(kids).not.toContain(chave.kid);
  });
});

describe('obterProxima e listarMetadados', () => {
  it('devolve a chave pré-publicada, ou null quando não há', async () => {
    expect(await repo.obterProxima()).toBeNull();

    const proxima = await repo.inserir(await novaEntrada('next'));

    expect((await repo.obterProxima())?.kid).toBe(proxima.kid);
  });

  it('lista metadados sem material de chave, filtrando por status', async () => {
    await repo.inserir(await novaEntrada('active'));
    const proxima = await repo.inserir(await novaEntrada('next'));

    const todos = await repo.listarMetadados();
    const soNext = await repo.listarMetadados({ status: 'next' });

    expect(todos).toHaveLength(2);
    expect(soNext.map((c) => c.kid)).toEqual([proxima.kid]);
    // O material cifrado não é sequer selecionado: não há o que vazar na serialização.
    expect(JSON.stringify(todos)).not.toContain('privateKeyEnc');
    expect(Object.keys(soNext[0] ?? {})).not.toContain('publicJwk');
  });
});
