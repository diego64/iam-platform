/**
 * Cobre a transação de rotação contra PostgreSQL real: a ordem que respeita o índice único
 * de chave ativa, o estado final da tabela, a recusa quando não há chave pré-publicada e a
 * exclusão entre réplicas — duas conexões disparando a rotação ao mesmo tempo só podem
 * produzir uma promoção.
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
const GRACA_MS = 15 * 60 * 1000;

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
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 6 });
  await recriarSchemaJwks(pool);
  repo = criarRepositorioJwks(pool);
});

beforeEach(async () => {
  await limparJwks(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('rotacionar', () => {
  it('aposenta a ativa e promove a pré-publicada numa transação', async () => {
    const anterior = await repo.inserir(await novaEntrada('active'));
    const proxima = await repo.inserir(await novaEntrada('next'));

    const resultado = await repo.rotacionar({ graceMs: GRACA_MS });

    expect(resultado).toEqual({
      situacao: 'rotacionada',
      kidAnterior: anterior.kid,
      kidAtivo: proxima.kid,
    });
    expect(await repo.contarPorStatus()).toEqual({ active: 1, next: 0, retired: 1 });
    expect((await repo.obterAtiva())?.kid).toBe(proxima.kid);
  });

  it('grava o fim da verificabilidade da chave aposentada dentro da janela pedida', async () => {
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));
    const antes = Date.now();

    const resultado = await repo.rotacionar({ graceMs: GRACA_MS });

    if (resultado.situacao !== 'rotacionada') throw new Error('esperava rotação');
    const [aposentada] = await repo.listarMetadados({ status: 'retired' });
    expect(aposentada?.kid).toBe(resultado.kidAnterior);
    expect(aposentada?.aposentadaEm).toBeInstanceOf(Date);
    const ate = aposentada?.verificavelAte?.getTime() ?? 0;
    expect(ate).toBeGreaterThanOrEqual(antes + GRACA_MS);
    expect(ate).toBeLessThanOrEqual(Date.now() + GRACA_MS);
  });

  it('com graceMs zero, a chave aposentada deixa de verificar imediatamente', async () => {
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));

    await repo.rotacionar({ graceMs: 0 });

    const kids = (await repo.listarElegiveis(new Date())).map((c) => c.kid);
    expect(kids).toHaveLength(1); // só a recém-promovida
    expect((await repo.contarPorStatus()).retired).toBe(1);
  });

  it('promove mesmo sem chave ativa anterior — o primeiro bootstrap não tem o que aposentar', async () => {
    const proxima = await repo.inserir(await novaEntrada('next'));

    const resultado = await repo.rotacionar({ graceMs: GRACA_MS });

    expect(resultado).toEqual({
      situacao: 'rotacionada',
      kidAnterior: null,
      kidAtivo: proxima.kid,
    });
  });

  it('recusa quando não há chave pré-publicada, sem tocar na ativa', async () => {
    const ativa = await repo.inserir(await novaEntrada('active'));

    expect(await repo.rotacionar({ graceMs: GRACA_MS })).toEqual({ situacao: 'sem-proxima' });
    expect((await repo.obterAtiva())?.kid).toBe(ativa.kid);
    expect(await repo.contarPorStatus()).toEqual({ active: 1, next: 0, retired: 0 });
  });

  it('nunca deixa o banco sem chave ativa, mesmo na recusa', async () => {
    await repo.inserir(await novaEntrada('active'));

    await repo.rotacionar({ graceMs: GRACA_MS });

    expect(await repo.obterAtiva()).not.toBeNull();
  });

  it('duas rotações concorrentes produzem uma promoção só', async () => {
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));

    // Repositórios distintos sobre o mesmo pool: cada rotação pega a própria conexão, que é
    // o que o cenário multi-réplica faz.
    const [a, b] = await Promise.all([
      criarRepositorioJwks(pool).rotacionar({ graceMs: GRACA_MS }),
      criarRepositorioJwks(pool).rotacionar({ graceMs: GRACA_MS }),
    ]);

    const situacoes = [a.situacao, b.situacao].sort();
    // A perdedora ou não pegou o lock, ou pegou depois e já não achou chave pré-publicada.
    expect(situacoes).toContain('rotacionada');
    expect(situacoes.filter((s) => s === 'rotacionada')).toHaveLength(1);
    expect(await repo.contarPorStatus()).toEqual({ active: 1, next: 0, retired: 1 });
  });

  it('libera o lock após o commit — a rotação seguinte não fica presa', async () => {
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));
    await repo.rotacionar({ graceMs: GRACA_MS });

    await repo.inserir(await novaEntrada('next'));

    expect((await repo.rotacionar({ graceMs: GRACA_MS })).situacao).toBe('rotacionada');
    expect(await repo.contarPorStatus()).toEqual({ active: 1, next: 0, retired: 2 });
  });

  it('libera o lock após a recusa — recusar não bloqueia a próxima tentativa', async () => {
    await repo.inserir(await novaEntrada('active'));

    expect((await repo.rotacionar({ graceMs: GRACA_MS })).situacao).toBe('sem-proxima');
    await repo.inserir(await novaEntrada('next'));

    expect((await repo.rotacionar({ graceMs: GRACA_MS })).situacao).toBe('rotacionada');
  });
});
