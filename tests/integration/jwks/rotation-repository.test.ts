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

    const kids = (await repo.listarElegiveis()).map((c) => c.kid);
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

describe('revogar', () => {
  it('encerra a verificabilidade de uma chave aposentada na hora', async () => {
    const chave = await repo.inserir(await novaEntrada('next'));
    await repo.inserir(await novaEntrada('active'));
    await repo.rotacionar({ graceMs: GRACA_MS });
    // Após a rotação, a chave acima é a ativa; aposenta-a para ter uma retired em graça.
    await repo.inserir(await novaEntrada('next'));
    await repo.rotacionar({ graceMs: GRACA_MS });

    const revogada = await repo.revogar(chave.kid);

    expect(revogada?.kid).toBe(chave.kid);
    expect(revogada?.status).toBe('retired');
    const kids = (await repo.listarElegiveis()).map((c) => c.kid);
    expect(kids).not.toContain(chave.kid);
  });

  it('revoga uma chave pré-publicada, que nunca assinou nada', async () => {
    const proxima = await repo.inserir(await novaEntrada('next'));

    const revogada = await repo.revogar(proxima.kid);

    expect(revogada?.status).toBe('retired');
    expect(await repo.obterProxima()).toBeNull();
  });

  // Sem promover a pré-publicada no mesmo commit, revogar a ativa deixaria o IdP sem
  // assinatura — esse caminho é a rotação com janela zero, não este.
  it('recusa-se a revogar a chave ativa', async () => {
    const ativa = await repo.inserir(await novaEntrada('active'));

    expect(await repo.revogar(ativa.kid)).toBeNull();
    expect((await repo.obterAtiva())?.kid).toBe(ativa.kid);
  });

  it('devolve null para kid inexistente', async () => {
    expect(await repo.revogar('0193b6e2-7f00-7cd1-9a3e-2b7c9f0a1d42')).toBeNull();
  });

  it('preserva o instante original da aposentadoria ao revogar quem já estava retired', async () => {
    await repo.inserir(await novaEntrada('active'));
    const alvo = await repo.inserir(await novaEntrada('next'));
    await repo.rotacionar({ graceMs: GRACA_MS });
    await repo.inserir(await novaEntrada('next'));
    await repo.rotacionar({ graceMs: GRACA_MS });
    const antes = await repo.obterMetadadosPorKid(alvo.kid);

    const depois = await repo.revogar(alvo.kid);

    expect(depois?.aposentadaEm?.toISOString()).toBe(antes?.aposentadaEm?.toISOString());
    // Revogar encurta a vida da chave: o fim da verificabilidade vem para agora, antes do
    // que a janela de graça havia marcado.
    expect(depois?.verificavelAte?.getTime()).toBeLessThan(antes?.verificavelAte?.getTime() ?? 0);
  });
});

describe('purgar', () => {
  /** Aposenta a chave com o fim de verificabilidade no instante informado. */
  async function encerrar(kid: string, verificavelAte: Date): Promise<void> {
    await pool.query(
      "UPDATE jwks SET status = 'retired', retired_at = now(), verifiable_until = $2 WHERE kid = $1",
      [kid, verificavelAte],
    );
  }

  it('remove chave que já não verifica há mais que a margem', async () => {
    const velha = await repo.inserir(await novaEntrada('retired'));
    await encerrar(velha.kid, new Date(Date.now() - 48 * 60 * 60 * 1000));

    expect(await repo.purgar(24 * 60 * 60 * 1000)).toBe(1);
    expect(await repo.obterMetadadosPorKid(velha.kid)).toBeNull();
  });

  it('preserva chave que ainda verifica — a margem nunca alcança o futuro', async () => {
    const viva = await repo.inserir(await novaEntrada('retired'));
    await encerrar(viva.kid, new Date(Date.now() + 60_000));

    expect(await repo.purgar(0)).toBe(0);
    expect(await repo.obterMetadadosPorKid(viva.kid)).not.toBeNull();
  });

  it('preserva chave dentro da margem, mesmo já tendo parado de verificar', async () => {
    const recente = await repo.inserir(await novaEntrada('retired'));
    await encerrar(recente.kid, new Date(Date.now() - 60_000));

    expect(await repo.purgar(24 * 60 * 60 * 1000)).toBe(0);
    expect(await repo.obterMetadadosPorKid(recente.kid)).not.toBeNull();
  });

  it('nunca toca em active nem em next', async () => {
    await repo.inserir(await novaEntrada('active'));
    await repo.inserir(await novaEntrada('next'));

    expect(await repo.purgar(0)).toBe(0);
    expect(await repo.contarPorStatus()).toEqual({ active: 1, next: 1, retired: 0 });
  });
});
