/**
 * Cobre o RepositorioDePapel contra PostgreSQL real: criar, buscar, listar com paginação,
 * atualizar, remover e o conflito de `name` (UNIQUE) virando ErroDeRbac.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioDePapel,
  type RepositorioDePapel,
} from '../../../src/modules/rbac/repositories/role.repository.js';
import { ErroDeRbac } from '../../../src/modules/rbac/errors/rbac.errors.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaRbac } from './schema.js';

let pool: Pool;
let repo: RepositorioDePapel;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchemaRbac(pool);
  repo = criarRepositorioDePapel(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Preserva o seed (superadmin); limpa só os papéis criados pelos testes.
  await pool.query('DELETE FROM roles WHERE is_system = false');
});

describe('RepositorioDePapel', () => {
  it('cria e busca por id', async () => {
    const criado = await repo.criar({ name: 'billing-admin', description: 'Cobrança' });
    expect(criado).toMatchObject({
      name: 'billing-admin',
      description: 'Cobrança',
      isSystem: false,
    });

    const achado = await repo.buscarPorId(criado.id);
    expect(achado?.name).toBe('billing-admin');
    expect(await repo.buscarPorId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('name duplicado dispara ErroDeRbac papel-conflito', async () => {
    await repo.criar({ name: 'dup', description: null });
    await expect(repo.criar({ name: 'dup', description: null })).rejects.toBeInstanceOf(ErroDeRbac);
  });

  it('lista em ordem de name com paginação e conta', async () => {
    await repo.criar({ name: 'aaa', description: null });
    await repo.criar({ name: 'bbb', description: null });
    await repo.criar({ name: 'ccc', description: null });

    const pagina = await repo.listar({ limite: 2, offset: 0 });
    // superadmin (seed) entra na ordenação: a@a, bbb, ccc, superadmin → primeiros 2
    expect(pagina.map((p) => p.name)).toEqual(['aaa', 'bbb']);
    expect(await repo.contar()).toBe(4); // 3 criados + superadmin
  });

  it('atualiza name e description', async () => {
    const criado = await repo.criar({ name: 'old', description: null });
    const atualizado = await repo.atualizar(criado.id, {
      name: 'new',
      description: 'agora com desc',
    });
    expect(atualizado).toMatchObject({ name: 'new', description: 'agora com desc' });
    expect(
      await repo.atualizar('00000000-0000-0000-0000-000000000000', {
        name: 'x',
        description: null,
      }),
    ).toBeNull();
  });

  it('remove e devolve boolean', async () => {
    const criado = await repo.criar({ name: 'temp', description: null });
    expect(await repo.remover(criado.id)).toBe(true);
    expect(await repo.remover(criado.id)).toBe(false);
  });
});
