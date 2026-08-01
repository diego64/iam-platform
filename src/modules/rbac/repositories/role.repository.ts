/**
 * Responsabilidade: acesso à tabela `roles` em PostgreSQL.
 * Consumido por: o `RbacService`.
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão (CLAUDE.md).
 *  - SQL sempre parametrizado; colunas nominais, nada de `SELECT *`.
 *  - Conflito de `name` (UNIQUE da 0001) vira `ErroDeRbac('papel-conflito')`; a
 *    imutabilidade de `is_system` é decisão do serviço, não do repositório.
 */
import type { Pool } from 'pg';
import type { Papel } from '../entities/rbac.entity.js';
import { ErroDeRbac } from '../errors/rbac.errors.js';

/** SQLSTATE de violação de unicidade — o UNIQUE(name) da 0001. */
const VIOLACAO_UNICIDADE = '23505';

const COLUNAS = 'id, name, description, is_system';

interface LinhaDePapel {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_system: boolean;
}

function paraEntidade(linha: LinhaDePapel): Papel {
  return {
    id: linha.id,
    name: linha.name,
    description: linha.description,
    isSystem: linha.is_system,
  };
}

function ehConflitoDeNome(erro: unknown): boolean {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { code?: unknown }).code === VIOLACAO_UNICIDADE
  );
}

export interface FiltroDePaginacao {
  readonly limite: number;
  readonly offset: number;
}

export interface RepositorioDePapel {
  criar(entrada: { name: string; description: string | null }): Promise<Papel>;
  buscarPorId(id: string): Promise<Papel | null>;
  listar(filtro: FiltroDePaginacao): Promise<Papel[]>;
  contar(): Promise<number>;
  atualizar(id: string, dados: { name: string; description: string | null }): Promise<Papel | null>;
  remover(id: string): Promise<boolean>;
}

export function criarRepositorioDePapel(pool: Pool): RepositorioDePapel {
  return {
    async criar(entrada): Promise<Papel> {
      try {
        const { rows } = await pool.query<LinhaDePapel>(
          `INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING ${COLUNAS}`,
          [entrada.name, entrada.description],
        );
        return paraEntidade(rows[0] as LinhaDePapel);
      } catch (erro) {
        if (ehConflitoDeNome(erro)) throw new ErroDeRbac('papel-conflito');
        throw erro;
      }
    },

    async buscarPorId(id: string): Promise<Papel | null> {
      const { rows } = await pool.query<LinhaDePapel>(
        `SELECT ${COLUNAS} FROM roles WHERE id = $1`,
        [id],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async listar(filtro): Promise<Papel[]> {
      const { rows } = await pool.query<LinhaDePapel>(
        `SELECT ${COLUNAS} FROM roles ORDER BY name LIMIT $1 OFFSET $2`,
        [filtro.limite, filtro.offset],
      );
      return rows.map(paraEntidade);
    },

    async contar(): Promise<number> {
      const { rows } = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM roles',
      );
      return Number(rows[0]?.total ?? '0');
    },

    async atualizar(id, dados): Promise<Papel | null> {
      try {
        const { rows } = await pool.query<LinhaDePapel>(
          `UPDATE roles SET name = $2, description = $3 WHERE id = $1 RETURNING ${COLUNAS}`,
          [id, dados.name, dados.description],
        );
        const linha = rows[0];
        return linha === undefined ? null : paraEntidade(linha);
      } catch (erro) {
        if (ehConflitoDeNome(erro)) throw new ErroDeRbac('papel-conflito');
        throw erro;
      }
    },

    async remover(id: string): Promise<boolean> {
      const { rowCount } = await pool.query('DELETE FROM roles WHERE id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },
  };
}
