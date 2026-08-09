/**
 * Contador de rate limit contra um Mongo real.
 *
 * O que este arquivo procura é o que a memória local não consegue provar: duas instâncias
 * somando no mesmo contador, o TTL limpando a coleção sozinho, a atomicidade sob concorrência
 * e — o mais importante — a falha de I/O devolvendo `null` em vez de derrubar a requisição.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import { criarContadorNoMongo } from '../../../src/shared/rate-limit/mongo-store.js';
import { derivarChave } from '../../../src/shared/rate-limit/chave.js';

const JANELA = 60_000;
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

let mongo: MongoClient;
let banco: Db;

beforeAll(async () => {
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('rate_limit_counters').deleteMany({});
});

function contador(aoFalhar?: (erro: unknown) => void): ReturnType<typeof criarContadorNoMongo> {
  return criarContadorNoMongo({
    banco,
    timeoutMs: 500,
    ...(aoFalhar === undefined ? {} : { aoFalhar }),
  });
}

describe('contagem compartilhada', () => {
  it('duas instâncias do contador somam na mesma chave', async () => {
    // É o ponto da SPEC: com o contador local, cada réplica teria a própria contagem e o
    // teto efetivo seria o número de réplicas vezes o configurado.
    const instanciaA = contador();
    const instanciaB = contador();

    await instanciaA.incrementar('ip:compartilhado', JANELA);
    await instanciaB.incrementar('ip:compartilhado', JANELA);
    const estado = await instanciaA.ler('ip:compartilhado');

    expect(estado?.contagem).toBe(2);
  });

  it('incrementos simultâneos na mesma chave contam todos', async () => {
    const alvo = contador();

    const resultados = await Promise.all(
      Array.from({ length: 10 }, () => alvo.incrementar('ip:corrida', JANELA)),
    );

    expect(resultados.every((r) => r !== null)).toBe(true);
    expect((await alvo.ler('ip:corrida'))?.contagem).toBe(10);
    // Cada chamada enxergou um valor distinto — o $inc é atômico, não lê-depois-escreve.
    expect(new Set(resultados.map((r) => r?.contagem)).size).toBe(10);
  });

  it('chaves diferentes não compartilham contagem', async () => {
    const alvo = contador();

    await alvo.incrementar('conta:a', JANELA);
    await alvo.incrementar('conta:a', JANELA);

    expect((await alvo.ler('conta:b'))?.contagem).toBe(0);
  });

  it('chave inexistente devolve zero, não null', async () => {
    // Zero é resposta; null é "não consegui responder". Confundir os dois faria o fail open
    // engolir uma contagem legítima.
    expect(await contador().ler('conta:nunca-vista')).toMatchObject({ contagem: 0 });
  });
});

describe('janela', () => {
  it('o incremento não empurra o vencimento para frente', async () => {
    const alvo = contador();

    const primeiro = await alvo.incrementar('ip:janela', JANELA);
    const segundo = await alvo.incrementar('ip:janela', JANELA);

    expect(segundo?.expiraEm.getTime()).toBe(primeiro?.expiraEm.getTime());
  });

  it('a coleção tem índice TTL', async () => {
    const indices = await banco.collection('rate_limit_counters').indexes();

    expect(indices.some((i) => i.key.expires_at === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});

describe('privacidade da chave', () => {
  it('nenhum e-mail em claro sobrevive na coleção', async () => {
    const alvo = contador();
    const email = 'vitima@iam.local';

    await alvo.incrementar(derivarChave('conta', email, PEPPER), JANELA);

    const documentos = await banco.collection('rate_limit_counters').find({}).toArray();
    const dump = JSON.stringify(documentos);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain('vitima');
  });
});

describe('fail open', () => {
  it('erro de I/O devolve null e avisa, sem lançar', async () => {
    // Banco fechado é o que acontece quando o Mongo cai no meio do tráfego.
    const { cliente: efemero, banco: bancoEfemero } = await conectarMongo(envDeIntegracao());
    await efemero.close();
    const falhas: unknown[] = [];
    const alvo = criarContadorNoMongo({
      banco: bancoEfemero,
      timeoutMs: 200,
      aoFalhar: (erro) => falhas.push(erro),
    });

    await expect(alvo.incrementar('ip:sem-banco', JANELA)).resolves.toBeNull();
    await expect(alvo.ler('ip:sem-banco')).resolves.toBeNull();
    expect(falhas).toHaveLength(2);
  });
});
