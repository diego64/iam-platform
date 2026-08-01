/**
 * Prova a atomicidade da rotação contra um MongoDB real: com N pedidos concorrentes sobre o
 * mesmo token `active`, exatamente um vence (recebe o documento anterior) e os demais recebem
 * `null`. É o que impede dois pares válidos saírem de um único refresh sob concorrência.
 * Também cobre a revogação de família.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import {
  criarRepositorioDeRefreshToken,
  type RepositorioDeRefreshToken,
} from '../../../src/modules/refresh-token/index.js';

let cliente: MongoClient;
let banco: Db;
let repo: RepositorioDeRefreshToken;

async function registrarAtivo(tokenHash: string, familyId: string): Promise<void> {
  const futuro = new Date(Date.now() + 3_600_000);
  await repo.registrar({
    tokenHash,
    familyId,
    userId: 'u1',
    idleExpiresAt: futuro,
    absoluteExpiresAt: futuro,
  });
}

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  repo = criarRepositorioDeRefreshToken(banco);
});

beforeEach(async () => {
  await banco.collection('refresh_tokens').deleteMany({});
});

afterAll(async () => {
  await cliente.close();
});

describe('rotacionarAtomico', () => {
  it('sob 10 pedidos concorrentes, exatamente um vence', async () => {
    await registrarAtivo('hash-corrida', 'fam-corrida');

    const resultados = await Promise.all(
      Array.from({ length: 10 }, () => repo.rotacionarAtomico('hash-corrida', new Date())),
    );

    const vencedores = resultados.filter((r) => r !== null);
    expect(vencedores).toHaveLength(1);
  });
});

describe('revogarFamilia', () => {
  it('marca revoked apenas os tokens active da família', async () => {
    await registrarAtivo('hash-a', 'fam-x');
    await registrarAtivo('hash-b', 'fam-x');
    await registrarAtivo('hash-outra', 'fam-y');

    await repo.revogarFamilia('fam-x');

    expect((await repo.buscarPorHash('hash-a'))?.status).toBe('revoked');
    expect((await repo.buscarPorHash('hash-b'))?.status).toBe('revoked');
    expect((await repo.buscarPorHash('hash-outra'))?.status).toBe('active');
  });
});
