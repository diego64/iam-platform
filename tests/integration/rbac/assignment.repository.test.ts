/**
 * Cobre o RepositorioDeAssociacao contra PostgreSQL real: associação idempotente e atômica
 * (id inexistente ⇒ rollback), cascade ao remover papel, permissões efetivas do usuário e
 * as recusas de existência (usuário/papel/permissão).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioDeAssociacao,
  type RepositorioDeAssociacao,
} from '../../../src/modules/rbac/repositories/assignment.repository.js';
import { ErroDeRbac } from '../../../src/modules/rbac/errors/rbac.errors.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaRbac } from './schema.js';

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
const ID_INEXISTENTE = '00000000-0000-0000-0000-000000000000';

let pool: Pool;
let repo: RepositorioDeAssociacao;

async function criarUsuario(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, HASH],
  );
  return rows[0]?.id ?? '';
}

async function criarPapel(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO roles (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0]?.id ?? '';
}

async function criarPermissao(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO permissions (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaRbac(pool);
  repo = criarRepositorioDeAssociacao(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE users, user_roles, role_permissions CASCADE');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await pool.query('DELETE FROM permissions WHERE is_system = false');
});

describe('associarPermissoes', () => {
  it('é idempotente e reflete no permissoesDoPapel', async () => {
    const papel = await criarPapel('billing');
    const p1 = await criarPermissao('billing:read');
    const p2 = await criarPermissao('billing:write');

    await repo.associarPermissoes(papel, [p1, p2]);
    await repo.associarPermissoes(papel, [p1, p2]); // reassociar não duplica nem falha

    expect(await repo.permissoesDoPapel(papel)).toEqual(['billing:read', 'billing:write']);
  });

  it('é atômico: permissão inexistente faz rollback sem persistir nada', async () => {
    const papel = await criarPapel('parcial');
    const p1 = await criarPermissao('parcial:read');

    await expect(repo.associarPermissoes(papel, [p1, ID_INEXISTENTE])).rejects.toBeInstanceOf(
      ErroDeRbac,
    );
    // Nada foi associado — a permissão válida não vazou pela falha da inválida.
    expect(await repo.permissoesDoPapel(papel)).toEqual([]);
  });

  it('papel inexistente ⇒ ErroDeRbac', async () => {
    const p = await criarPermissao('x:y');
    await expect(repo.associarPermissoes(ID_INEXISTENTE, [p])).rejects.toBeInstanceOf(ErroDeRbac);
  });
});

describe('atribuirPapeis e permissoesEfetivas', () => {
  it('coleta permissões distintas de todos os papéis do usuário', async () => {
    const user = await criarUsuario('u@iam.local');
    const admin = await criarPapel('admin');
    const editor = await criarPapel('editor');
    const pRead = await criarPermissao('users:read');
    const pWrite = await criarPermissao('users:write');
    // Permissão repetida entre papéis não deve duplicar no efetivo.
    await repo.associarPermissoes(admin, [pRead, pWrite]);
    await repo.associarPermissoes(editor, [pRead]);
    await repo.atribuirPapeis(user, [admin, editor]);

    expect(await repo.permissoesEfetivas(user)).toEqual(['users:read', 'users:write']);
    expect((await repo.papeisDoUsuario(user)).map((p) => p.name)).toEqual(['admin', 'editor']);
  });

  it('usuário inexistente ⇒ ErroDeRbac, atribuição não persiste', async () => {
    const papel = await criarPapel('qualquer');
    await expect(repo.atribuirPapeis(ID_INEXISTENTE, [papel])).rejects.toBeInstanceOf(ErroDeRbac);
  });

  it('desatribuir papel remove só aquele vínculo', async () => {
    const user = await criarUsuario('v@iam.local');
    const a = await criarPapel('a');
    const b = await criarPapel('b');
    await repo.atribuirPapeis(user, [a, b]);
    await repo.desatribuirPapel(user, a);
    expect((await repo.papeisDoUsuario(user)).map((p) => p.name)).toEqual(['b']);
  });
});

describe('cascade ao remover papel', () => {
  it('remove as linhas de user_roles e role_permissions sem deixar órfãos', async () => {
    const user = await criarUsuario('c@iam.local');
    const papel = await criarPapel('temp');
    const perm = await criarPermissao('temp:read');
    await repo.associarPermissoes(papel, [perm]);
    await repo.atribuirPapeis(user, [papel]);

    await pool.query('DELETE FROM roles WHERE id = $1', [papel]);

    const ur = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_roles WHERE role_id = $1',
      [papel],
    );
    const rp = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM role_permissions WHERE role_id = $1',
      [papel],
    );
    expect(ur.rows[0]?.n).toBe(0);
    expect(rp.rows[0]?.n).toBe(0);
  });
});
