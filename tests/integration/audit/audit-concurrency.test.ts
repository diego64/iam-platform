/**
 * Prova que a trilha não bifurca sob concorrência.
 *
 * É a garantia que sustenta todo o resto: se dois processos lerem o mesmo topo e escreverem
 * a partir dele, sobram duas posições iguais ou dois elos apontando para o mesmo anterior, e
 * a verificação de integridade passa a acusar adulteração em trilha honesta. O compare-and-set
 * no documento de topo existe exatamente para isso, e só um teste concorrente contra o Mongo
 * real o comprova.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import {
  criarRepositorioDaTrilha,
  type EventoParaAnexar,
  type RepositorioDaTrilha,
} from '../../../src/modules/audit/repositories/audit-log.repository.js';
import { HASH_DE_GENESE } from '../../../src/modules/audit/types/audit-event.js';

const ESCRITAS = 200;

let cliente: MongoClient;
let banco: Db;
let repo: RepositorioDaTrilha;

function evento(indice: number): EventoParaAnexar {
  return {
    eventId: `evt-concorrente-${String(indice)}`,
    type: 'iam.auth.login',
    occurredAt: new Date(),
    actor: { id: `u${String(indice)}`, type: 'user' },
    target: null,
    outcome: 'success',
    reason: null,
    subjectHint: null,
    metadata: {},
    requestId: null,
    traceId: null,
  };
}

function hashDe(seq: number, prevHash: string): string {
  return createHash('sha256')
    .update(`${String(seq)}:${prevHash}`)
    .digest('hex');
}

/** As posições devolvidas pela rajada — uma rajada só, três verificações sobre ela. */
let posicoes: number[];

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  // Teto alto: com 200 escritas disputando um documento de topo, o número de voltas é a
  // própria contenção que se quer medir — desistir aqui seria testar o teto, não a cadeia.
  repo = criarRepositorioDaTrilha(banco, { maxTentativas: ESCRITAS * 2 });

  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});
  await repo.garantirGenese();

  // A rajada roda uma vez: disputar o topo 200 vezes é caro, e as três asserções descrevem
  // propriedades do mesmo resultado.
  const resultados = await Promise.all(
    Array.from({ length: ESCRITAS }, (_valor, indice) => repo.anexar(evento(indice), hashDe)),
  );
  posicoes = resultados.map((resultado) => resultado.evento.seq).sort((a, b) => a - b);
}, 120_000);

afterAll(async () => {
  await cliente.close();
});

describe('anexar sob concorrência', () => {
  it('produz posições contíguas de 1 a N, sem buraco e sem duplicata', () => {
    expect(posicoes).toEqual(Array.from({ length: ESCRITAS }, (_valor, i) => i + 1));
    expect(new Set(posicoes).size).toBe(ESCRITAS);
  });

  it('deixa a cadeia íntegra: cada elo aponta para o hash do anterior', async () => {
    let anterior = HASH_DE_GENESE;
    let contados = 0;
    for await (const item of repo.lerFaixa(1, ESCRITAS)) {
      expect(item.prevHash).toBe(anterior);
      expect(item.hash).toBe(hashDe(item.seq, anterior));
      anterior = item.hash;
      contados += 1;
    }

    expect(contados).toBe(ESCRITAS);
    expect(await repo.topo()).toEqual({ seq: ESCRITAS, hash: anterior });
  });

  it('materializa um documento por posição reservada', async () => {
    expect(await banco.collection('audit_log').countDocuments({})).toBe(ESCRITAS);
  });
});
