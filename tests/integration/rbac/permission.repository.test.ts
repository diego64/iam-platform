/**
 * Cobre o RepositorioDePermissao contra PostgreSQL real: criar, buscar, listar, contar,
 * remover e o conflito de `name` virando ErroDeRbac.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioDePermissao,
  type RepositorioDePermissao,
} from '../../../src/modules/rbac/repositories/permission.repository.js';
import { ErroDeRbac } from '../../../src/modules/rbac/errors/rbac.errors.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaRbac } from './schema.js';

let pool: Pool;
let repo: RepositorioDePermissao;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchemaRbac(pool);
  repo = criarRepositorioDePermissao(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Preserva as permissões-base (seed); limpa só as criadas pelos testes.
  await pool.query('DELETE FROM permissions WHERE is_system = false');
});

describe('RepositorioDePermissao', () => {
  it('cria e busca por id', async () => {
    const criada = await repo.criar({ name: 'billing:read', description: null });
    expect(criada).toMatchObject({ name: 'billing:read', isSystem: false });
    expect((await repo.buscarPorId(criada.id))?.name).toBe('billing:read');
    expect(await repo.buscarPorId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('name duplicado dispara ErroDeRbac permissao-conflito', async () => {
    await repo.criar({ name: 'billing:write', description: null });
    await expect(repo.criar({ name: 'billing:write', description: null })).rejects.toBeInstanceOf(
      ErroDeRbac,
    );
  });

  it('lista em ordem e conta (inclui o seed)', async () => {
    await repo.criar({ name: 'zzz:read', description: null });
    const todas = await repo.listar({ limite: 100, offset: 0 });
    expect(todas.some((p) => p.name === 'roles:write')).toBe(true); // seed
    expect(todas.some((p) => p.name === 'zzz:read')).toBe(true);
    // 7 do seed (roles:*, permissions:*, *) + 1 criada
    expect(await repo.contar()).toBe(8);
  });

  it('remove e devolve boolean', async () => {
    const criada = await repo.criar({ name: 'temp:acao', description: null });
    expect(await repo.remover(criada.id)).toBe(true);
    expect(await repo.remover(criada.id)).toBe(false);
  });
});
