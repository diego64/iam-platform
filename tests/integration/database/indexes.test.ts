/**
 * Valida os índices de iam_sessions contra um MongoDB real (compose de teste):
 * unicidade, TTL com expireAfterSeconds 0 e idempotência de garantirIndices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

let cliente: MongoClient;
let banco: Db;

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await banco.dropDatabase(); // parte de um estado conhecido
  await garantirIndices(banco);
});

afterAll(async () => {
  await cliente.close();
});

/** Índices da coleção, indexados pelo nome gerado pelo driver. */
async function indicesDe(colecao: string): Promise<Map<string, Record<string, unknown>>> {
  const lista = (await banco.collection(colecao).indexes()) as unknown as Record<string, unknown>[];
  return new Map(lista.map((indice) => [String(indice['name']), indice]));
}

describe('garantirIndices — refresh_tokens', () => {
  it('cria índice único em token_hash', async () => {
    const indices = await indicesDe('refresh_tokens');

    expect(indices.get('token_hash_1')?.['unique']).toBe(true);
  });

  it('cria índice de busca por user_id', async () => {
    const indices = await indicesDe('refresh_tokens');

    expect(indices.has('user_id_1')).toBe(true);
  });

  it('cria índice TTL em expires_at com expireAfterSeconds 0', async () => {
    const indices = await indicesDe('refresh_tokens');

    expect(indices.get('expires_at_1')?.['expireAfterSeconds']).toBe(0);
  });
});

describe('garantirIndices — token_denylist', () => {
  it('cria índice único em jti', async () => {
    const indices = await indicesDe('token_denylist');

    expect(indices.get('jti_1')?.['unique']).toBe(true);
  });

  it('cria índice TTL em expires_at com expireAfterSeconds 0', async () => {
    const indices = await indicesDe('token_denylist');

    expect(indices.get('expires_at_1')?.['expireAfterSeconds']).toBe(0);
  });
});

describe('garantirIndices — idempotência', () => {
  it('roda duas vezes seguidas sem lançar e sem duplicar índices', async () => {
    const antes = await indicesDe('refresh_tokens');

    await expect(garantirIndices(banco)).resolves.toBeUndefined();
    await expect(garantirIndices(banco)).resolves.toBeUndefined();

    const depois = await indicesDe('refresh_tokens');
    expect(depois.size).toBe(antes.size);
  });
});
