/**
 * Cobre o bootstrap da primeira chave contra PostgreSQL real: a primeira execução cria a
 * chave active; a segunda é no-op (idempotente) e não viola o índice único parcial.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioJwks,
  type RepositorioJwks,
} from '../../../src/modules/jwks/repositories/jwks.repository.js';
import { garantirChaveDeBootstrap } from '../../../src/modules/jwks/services/bootstrap-key.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparJwks, recriarSchemaJwks } from './schema.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const logger = criarLogger({ nivel: 'fatal' });

let pool: Pool;
let repo: RepositorioJwks;

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

describe('garantirChaveDeBootstrap', () => {
  it('cria a chave active na primeira execução', async () => {
    const resultado = await garantirChaveDeBootstrap({ repo, masterKey: MASTER, logger });

    expect(resultado.criada).toBe(true);
    expect(resultado.kid).toBeTruthy();
    expect((await repo.contarPorStatus()).active).toBe(1);
  });

  it('é idempotente: a segunda execução não cria outra active', async () => {
    const primeira = await garantirChaveDeBootstrap({ repo, masterKey: MASTER, logger });
    const segunda = await garantirChaveDeBootstrap({ repo, masterKey: MASTER, logger });

    expect(primeira.criada).toBe(true);
    expect(segunda.criada).toBe(false);
    expect((await repo.contarPorStatus()).active).toBe(1);
    // O kid não muda: a chave original permanece.
    expect((await repo.obterAtiva())?.kid).toBe(primeira.kid);
  });
});
