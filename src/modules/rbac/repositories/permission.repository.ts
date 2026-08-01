/**
 * Responsabilidade: acesso à tabela `permissions` em PostgreSQL.
 * Consumido por: o `RbacService`.
 * Regras: `Pool` por injeção; SQL parametrizado; conflito de `name` vira ErroDeRbac.
 * Permissão não tem update (a borda só expõe POST/GET/DELETE): renomear uma permissão
 * quebraria silenciosamente os tokens que já a carregam.
 */
import type { Pool } from 'pg';
import type { Permissao } from '../entities/rbac.entity.js';
import { ErroDeRbac } from '../errors/rbac.errors.js';

const VIOLACAO_UNICIDADE = '23505';
const COLUNAS = 'id, name, description, is_system';

interface LinhaDePermissao {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_system: boolean;
}

function paraEntidade(linha: LinhaDePermissao): Permissao {
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

export interface RepositorioDePermissao {
  criar(entrada: { name: string; description: string | null }): Promise<Permissao>;
  buscarPorId(id: string): Promise<Permissao | null>;
  listar(filtro: FiltroDePaginacao): Promise<Permissao[]>;
  contar(): Promise<number>;
  remover(id: string): Promise<boolean>;
}

export function criarRepositorioDePermissao(pool: Pool): RepositorioDePermissao {
  return {
    async criar(entrada): Promise<Permissao> {
      try {
        const { rows } = await pool.query<LinhaDePermissao>(
          `INSERT INTO permissions (name, description) VALUES ($1, $2) RETURNING ${COLUNAS}`,
          [entrada.name, entrada.description],
        );
        return paraEntidade(rows[0] as LinhaDePermissao);
      } catch (erro) {
        if (ehConflitoDeNome(erro)) throw new ErroDeRbac('permissao-conflito');
        throw erro;
      }
    },

    async buscarPorId(id: string): Promise<Permissao | null> {
      const { rows } = await pool.query<LinhaDePermissao>(
        `SELECT ${COLUNAS} FROM permissions WHERE id = $1`,
        [id],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async listar(filtro): Promise<Permissao[]> {
      const { rows } = await pool.query<LinhaDePermissao>(
        `SELECT ${COLUNAS} FROM permissions ORDER BY name LIMIT $1 OFFSET $2`,
        [filtro.limite, filtro.offset],
      );
      return rows.map(paraEntidade);
    },

    async contar(): Promise<number> {
      const { rows } = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM permissions',
      );
      return Number(rows[0]?.total ?? '0');
    },

    async remover(id: string): Promise<boolean> {
      const { rowCount } = await pool.query('DELETE FROM permissions WHERE id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },
  };
}
