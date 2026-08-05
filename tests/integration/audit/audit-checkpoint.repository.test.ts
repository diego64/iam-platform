/**
 * Cobre a âncora da cadeia contra PostgreSQL real: gravação idempotente por posição e a
 * busca do checkpoint aplicável a uma posição — que é o que denuncia truncamento da trilha.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioDeCheckpoint,
  type RepositorioDeCheckpoint,
} from '../../../src/modules/audit/repositories/audit-checkpoint.repository.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarCheckpoints } from './schema.js';

let pool: Pool;
let repo: RepositorioDeCheckpoint;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste() });
  await recriarCheckpoints(pool);
  repo = criarRepositorioDeCheckpoint(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE audit_checkpoints');
});

afterAll(async () => {
  await pool.end();
});

describe('gravar', () => {
  it('persiste a posição e o hash do topo', async () => {
    await repo.gravar(100, 'a'.repeat(64));

    const gravado = await repo.ultimo();
    expect(gravado?.seq).toBe(100);
    expect(gravado?.hash).toBe('a'.repeat(64));
    expect(gravado?.criadoEm).toBeInstanceOf(Date);
  });

  it('é idempotente por posição: gravar de novo não duplica nem falha', async () => {
    await repo.gravar(100, 'a'.repeat(64));
    await expect(repo.gravar(100, 'a'.repeat(64))).resolves.toBeUndefined();

    const { rows } = await pool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM audit_checkpoints',
    );
    expect(rows[0]?.total).toBe('1');
  });

  it('mantém a âncora original quando a mesma posição chega com hash diferente', async () => {
    await repo.gravar(100, 'a'.repeat(64));
    await repo.gravar(100, 'b'.repeat(64));

    expect((await repo.ultimo())?.hash).toBe('a'.repeat(64));
  });
});

describe('ultimoAte', () => {
  beforeEach(async () => {
    await repo.gravar(100, 'a'.repeat(64));
    await repo.gravar(200, 'b'.repeat(64));
    await repo.gravar(300, 'c'.repeat(64));
  });

  it('devolve o checkpoint mais recente que não ultrapassa a posição', async () => {
    expect((await repo.ultimoAte(250))?.seq).toBe(200);
  });

  it('inclui a posição exata do checkpoint', async () => {
    expect((await repo.ultimoAte(200))?.seq).toBe(200);
  });

  it('devolve null quando nenhuma âncora alcança a posição', async () => {
    expect(await repo.ultimoAte(50)).toBeNull();
  });

  it('devolve a âncora mais alta quando a posição está além de todas', async () => {
    expect((await repo.ultimoAte(9_999))?.seq).toBe(300);
  });
});

describe('ultimo', () => {
  it('devolve null com a tabela vazia', async () => {
    expect(await repo.ultimo()).toBeNull();
  });

  it('converte a posição de BIGINT para número, sem devolver texto', async () => {
    await repo.gravar(42, 'd'.repeat(64));

    expect(await repo.ultimo()).toMatchObject({ seq: 42 });
    expect(typeof (await repo.ultimo())?.seq).toBe('number');
  });
});
