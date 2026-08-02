/**
 * Responsabilidade: as tabelas pivot do RBAC — `role_permissions` e `user_roles` — e os
 * joins de leitura que a borda e o token precisam.
 * Consumido por: o `RbacService`, o `AssignmentService` e o login (permissões efetivas).
 * Regras:
 *  - `Pool` por injeção; SQL parametrizado; escrita de associação sempre em transação.
 *  - Associação idempotente (`ON CONFLICT DO NOTHING`): reassociar não é erro.
 *  - Existência do papel/usuário é checada com SELECT dentro da transação; a existência
 *    da outra ponta (permissão/papel do pivot) vem da violação de FK (23503), já que a
 *    primeira ponta acabou de ser confirmada.
 *  - A permissão curinga `*` nunca é associada pela API: ela pertence só ao papel semeado.
 */
import type { Pool, PoolClient } from 'pg';
import { ErroDeRbac } from '../errors/rbac.errors.js';

/** SQLSTATE de violação de chave estrangeira. */
const VIOLACAO_FK = '23503';

function ehViolacaoDeFk(erro: unknown): boolean {
  return (
    typeof erro === 'object' && erro !== null && (erro as { code?: unknown }).code === VIOLACAO_FK
  );
}

/** Papel resumido para a listagem de papéis de um usuário. */
export interface PapelResumo {
  readonly id: string;
  readonly name: string;
}

export interface RepositorioDeAssociacao {
  associarPermissoes(roleId: string, permissionIds: readonly string[]): Promise<void>;
  desassociarPermissao(roleId: string, permissionId: string): Promise<void>;
  /** Nomes das permissões de um papel, em ordem — alimenta GET /roles/:id. */
  permissoesDoPapel(roleId: string): Promise<string[]>;
  /** Permissões efetivas (distintas) de um usuário via seus papéis — alimenta o token. */
  permissoesEfetivas(userId: string): Promise<string[]>;
  papeisDoUsuario(userId: string): Promise<PapelResumo[]>;
  atribuirPapeis(userId: string, roleIds: readonly string[]): Promise<void>;
  desatribuirPapel(userId: string, roleId: string): Promise<void>;
  usuarioExiste(userId: string): Promise<boolean>;
}

export function criarRepositorioDeAssociacao(pool: Pool): RepositorioDeAssociacao {
  async function emTransacao<T>(fn: (cliente: PoolClient) => Promise<T>): Promise<T> {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const resultado = await fn(cliente);
      await cliente.query('COMMIT');
      return resultado;
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    } finally {
      cliente.release();
    }
  }

  return {
    async associarPermissoes(roleId, permissionIds): Promise<void> {
      await emTransacao(async (cliente) => {
        const papel = await cliente.query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
        if (papel.rowCount === 0) throw new ErroDeRbac('papel-nao-encontrado');
        // O curinga global só existe no papel semeado: conceder `*` a qualquer outro papel
        // entrega acesso total a quem entrar nele, então a API nunca o associa.
        const curinga = await cliente.query(
          `SELECT 1 FROM permissions WHERE id = ANY($1::uuid[]) AND name = '*'`,
          [permissionIds],
        );
        if (curinga.rowCount !== 0) throw new ErroDeRbac('permissao-imutavel');
        try {
          await cliente.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT DO NOTHING`,
            [roleId, permissionIds],
          );
        } catch (erro) {
          if (ehViolacaoDeFk(erro)) throw new ErroDeRbac('permissao-nao-encontrada');
          throw erro;
        }
      });
    },

    async desassociarPermissao(roleId, permissionId): Promise<void> {
      const papel = await pool.query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
      if (papel.rowCount === 0) throw new ErroDeRbac('papel-nao-encontrado');
      await pool.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2', [
        roleId,
        permissionId,
      ]);
    },

    async permissoesDoPapel(roleId): Promise<string[]> {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT p.name
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1
          ORDER BY p.name`,
        [roleId],
      );
      return rows.map((l) => l.name);
    },

    async permissoesEfetivas(userId): Promise<string[]> {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT DISTINCT p.name
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = $1
          ORDER BY p.name`,
        [userId],
      );
      return rows.map((l) => l.name);
    },

    async papeisDoUsuario(userId): Promise<PapelResumo[]> {
      const { rows } = await pool.query<PapelResumo>(
        `SELECT r.id, r.name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1
          ORDER BY r.name`,
        [userId],
      );
      return rows.map((l) => ({ id: l.id, name: l.name }));
    },

    async atribuirPapeis(userId, roleIds): Promise<void> {
      await emTransacao(async (cliente) => {
        const usuario = await cliente.query('SELECT 1 FROM users WHERE id = $1', [userId]);
        if (usuario.rowCount === 0) throw new ErroDeRbac('usuario-nao-encontrado');
        try {
          await cliente.query(
            `INSERT INTO user_roles (user_id, role_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT DO NOTHING`,
            [userId, roleIds],
          );
        } catch (erro) {
          if (ehViolacaoDeFk(erro)) throw new ErroDeRbac('papel-nao-encontrado');
          throw erro;
        }
      });
    },

    async desatribuirPapel(userId, roleId): Promise<void> {
      const usuario = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (usuario.rowCount === 0) throw new ErroDeRbac('usuario-nao-encontrado');
      await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [
        userId,
        roleId,
      ]);
    },

    async usuarioExiste(userId): Promise<boolean> {
      const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      return (rowCount ?? 0) > 0;
    },
  };
}
