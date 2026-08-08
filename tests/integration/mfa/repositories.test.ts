/**
 * Repositórios de MFA contra PG e Mongo reais.
 *
 * O que este arquivo procura é concorrência: o mesmo código de recuperação consumido duas
 * vezes ao mesmo tempo e o mesmo desafio resolvido duas vezes ao mesmo tempo. Nos dois casos
 * pode haver no máximo um vencedor — do contrário um segundo fator vira um fator e meio.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparMfa, recriarSchemaDeMfa } from './schema.js';
import {
  criarRepositorioDeFatorDeMfa,
  type RepositorioDeFatorDeMfa,
} from '../../../src/modules/mfa/repositories/mfa-factor.repository.js';
import {
  criarRepositorioDeCodigosDeRecuperacao,
  type RepositorioDeCodigosDeRecuperacao,
} from '../../../src/modules/mfa/repositories/recovery-code.repository.js';
import {
  criarRepositorioDeDesafioDeMfa,
  type RepositorioDeDesafioDeMfa,
} from '../../../src/modules/mfa/repositories/mfa-challenge.repository.js';

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let fatores: RepositorioDeFatorDeMfa;
let codigos: RepositorioDeCodigosDeRecuperacao;
let desafios: RepositorioDeDesafioDeMfa;
let userId: string;

const SEGREDO = Buffer.from('blob-cifrado');

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 6 });
  await recriarSchemaDeMfa(pool);
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);

  fatores = criarRepositorioDeFatorDeMfa(pool);
  codigos = criarRepositorioDeCodigosDeRecuperacao(pool);
  desafios = criarRepositorioDeDesafioDeMfa(banco);

  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    ['mfa-repo@iam.local', 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
  );
  userId = rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.end();
  await mongo.close();
});

beforeEach(async () => {
  await limparMfa(pool);
  await banco.collection('mfa_challenges').deleteMany({});
});

describe('repositório do fator', () => {
  it('cria pendente, ativa e passa a ser encontrado como ativo', async () => {
    const pendente = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });

    expect(await fatores.buscarAtivo(userId)).toBeNull();
    expect((await fatores.buscarPendente(userId))?.id).toBe(pendente.id);

    expect(await fatores.ativar(pendente.id, 100)).toBe(true);

    const ativo = await fatores.buscarAtivo(userId);
    expect(ativo).toMatchObject({ id: pendente.id, status: 'active', ultimoPasso: 100 });
    expect(ativo?.confirmadoEm).not.toBeNull();
    expect(await fatores.buscarPendente(userId)).toBeNull();
  });

  it('o segredo volta byte a byte', async () => {
    const pendente = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });

    expect((await fatores.buscarPendente(userId))?.segredoCifrado.equals(SEGREDO)).toBe(true);
    expect(pendente.segredoCifrado.equals(SEGREDO)).toBe(true);
  });

  it('novo cadastro substitui o pendente anterior', async () => {
    const primeiro = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });
    const segundo = await fatores.criarPendente({
      userId,
      segredoCifrado: Buffer.from('outro'),
      label: 'iPhone',
    });

    expect(segundo.id).not.toBe(primeiro.id);
    expect((await fatores.buscarPendente(userId))?.id).toBe(segundo.id);
  });

  it('ativar duas vezes o mesmo pendente só funciona na primeira', async () => {
    const pendente = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });

    expect(await fatores.ativar(pendente.id, 100)).toBe(true);
    expect(await fatores.ativar(pendente.id, 101)).toBe(false);
  });

  it('o passo consumido nunca retrocede', async () => {
    // Requisição atrasada não pode reabrir um passo já gasto: seria devolver exatamente a
    // janela de replay que o anti-replay fecha.
    const pendente = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });
    await fatores.ativar(pendente.id, 100);

    await fatores.registrarUso(pendente.id, 99);

    expect((await fatores.buscarAtivo(userId))?.ultimoPasso).toBe(100);

    await fatores.registrarUso(pendente.id, 101);

    expect((await fatores.buscarAtivo(userId))?.ultimoPasso).toBe(101);
  });

  it('remover leva ativo e pendente do usuário', async () => {
    const ativo = await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });
    await fatores.ativar(ativo.id, 1);
    await fatores.criarPendente({ userId, segredoCifrado: SEGREDO, label: null });

    expect(await fatores.removerDoUsuario(userId)).toBe(2);
    expect(await fatores.buscarAtivo(userId)).toBeNull();
    expect(await fatores.buscarPendente(userId)).toBeNull();
  });
});

describe('repositório dos códigos de recuperação', () => {
  it('substitui o conjunto inteiro', async () => {
    await codigos.substituir(userId, ['h1', 'h2', 'h3']);
    expect(await codigos.contarValidos(userId)).toBe(3);

    await codigos.substituir(userId, ['h4']);

    expect(await codigos.contarValidos(userId)).toBe(1);
    expect(await codigos.consumir(userId, 'h1')).toBe(false);
  });

  it('consome uma vez e nunca mais', async () => {
    await codigos.substituir(userId, ['h1', 'h2']);

    expect(await codigos.consumir(userId, 'h1')).toBe(true);
    expect(await codigos.consumir(userId, 'h1')).toBe(false);
    expect(await codigos.contarValidos(userId)).toBe(1);
  });

  it('consumo concorrente do mesmo código tem um único vencedor', async () => {
    await codigos.substituir(userId, ['corrida']);

    const resultados = await Promise.all([
      codigos.consumir(userId, 'corrida'),
      codigos.consumir(userId, 'corrida'),
      codigos.consumir(userId, 'corrida'),
    ]);

    expect(resultados.filter(Boolean)).toHaveLength(1);
  });

  it('código de outro usuário não é consumível', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [`outro-${String(Date.now())}@iam.local`, 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
    );
    await codigos.substituir(userId, ['do-dono']);

    expect(await codigos.consumir(rows[0]?.id ?? '', 'do-dono')).toBe(false);
    expect(await codigos.contarValidos(userId)).toBe(1);
  });
});

describe('repositório do desafio', () => {
  it('cria, encontra e consome uma única vez', async () => {
    await desafios.criar({ tokenHash: 'h', userId, expiraEm: new Date(Date.now() + 60_000) });

    expect(await desafios.buscar('h')).toEqual({ userId, tentativas: 0 });
    expect(await desafios.consumir('h')).toEqual({ userId, tentativas: 0 });
    expect(await desafios.consumir('h')).toBeNull();
    expect(await desafios.buscar('h')).toBeNull();
  });

  it('consumo concorrente tem um único vencedor', async () => {
    // Dois `verify` simultâneos com o mesmo desafio não podem virar dois pares de tokens.
    await desafios.criar({ tokenHash: 'corrida', userId, expiraEm: new Date(Date.now() + 60_000) });

    const resultados = await Promise.all([
      desafios.consumir('corrida'),
      desafios.consumir('corrida'),
      desafios.consumir('corrida'),
    ]);

    expect(resultados.filter((r) => r !== null)).toHaveLength(1);
  });

  it('conta as tentativas de forma acumulada', async () => {
    await desafios.criar({ tokenHash: 'h', userId, expiraEm: new Date(Date.now() + 60_000) });

    expect(await desafios.registrarFalha('h')).toBe(1);
    expect(await desafios.registrarFalha('h')).toBe(2);
    expect((await desafios.buscar('h'))?.tentativas).toBe(2);
  });

  it('falha num desafio inexistente não estoura', async () => {
    expect(await desafios.registrarFalha('nao-existe')).toBe(0);
  });

  it('remove todos os desafios abertos de um usuário', async () => {
    await desafios.criar({ tokenHash: 'a', userId, expiraEm: new Date(Date.now() + 60_000) });
    await desafios.criar({ tokenHash: 'b', userId, expiraEm: new Date(Date.now() + 60_000) });

    await desafios.removerDoUsuario(userId);

    expect(await desafios.buscar('a')).toBeNull();
    expect(await desafios.buscar('b')).toBeNull();
  });

  it('a coleção tem índice TTL e único', async () => {
    const indices = await banco.collection('mfa_challenges').indexes();

    expect(indices.some((i) => i.key.token_hash === 1 && i.unique === true)).toBe(true);
    expect(indices.some((i) => i.key.expires_at === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});
