/**
 * Responsabilidade: acesso à tabela `policies` em PostgreSQL.
 * Consumido por: o `AbacService` (administração) e o motor PDP (`listarAplicaveis`).
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão (CLAUDE.md).
 *  - SQL sempre parametrizado, colunas nominais; a condição viaja como parâmetro `jsonb`,
 *    nunca concatenada.
 *  - Conflito de `name` (UNIQUE) vira `ErroDeAbac('politica-conflito')`; a imutabilidade de
 *    `is_system` é decisão do serviço, não do repositório.
 */
import type { Pool } from 'pg';
import { ErroDeAbac } from '../errors/abac.errors.js';
import type { Condicao, Efeito, Politica } from '../types/abac.types.js';

/** SQLSTATE de violação de unicidade — o UNIQUE(name) da 0005. */
const VIOLACAO_UNICIDADE = '23505';

const COLUNAS =
  'id, name, description, effect, resource_type, action, condition, priority, enabled, is_system';

interface LinhaDePolitica {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly effect: Efeito;
  readonly resource_type: string;
  readonly action: string;
  readonly condition: Condicao;
  readonly priority: number;
  readonly enabled: boolean;
  readonly is_system: boolean;
}

function paraEntidade(linha: LinhaDePolitica): Politica {
  return {
    id: linha.id,
    name: linha.name,
    description: linha.description,
    effect: linha.effect,
    resourceType: linha.resource_type,
    action: linha.action,
    condition: linha.condition,
    priority: linha.priority,
    enabled: linha.enabled,
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

/** Campos gravados numa política — o serviço resolve o patch contra a linha existente. */
export interface DadosDePolitica {
  readonly name: string;
  readonly description: string | null;
  readonly effect: Efeito;
  readonly resourceType: string;
  readonly action: string;
  readonly condition: Condicao;
  readonly priority: number;
  readonly enabled: boolean;
}

export interface FiltroDePolitica {
  readonly resourceType?: string;
  readonly enabled?: boolean;
  readonly limite: number;
  readonly offset: number;
}

export interface RepositorioDePolitica {
  criar(dados: DadosDePolitica): Promise<Politica>;
  buscarPorId(id: string): Promise<Politica | null>;
  listar(filtro: FiltroDePolitica): Promise<Politica[]>;
  contar(filtro: Pick<FiltroDePolitica, 'resourceType' | 'enabled'>): Promise<number>;
  atualizar(id: string, dados: DadosDePolitica): Promise<Politica | null>;
  remover(id: string): Promise<boolean>;
  /** Políticas ligadas cujo alvo casa com `(resourceType, action)` ou com o curinga `*`. */
  listarAplicaveis(resourceType: string, action: string): Promise<Politica[]>;
}

export function criarRepositorioDePolitica(pool: Pool): RepositorioDePolitica {
  /** Filtro opcional compartilhado por `listar` e `contar`, com os mesmos placeholders. */
  function condicaoDeFiltro(filtro: Pick<FiltroDePolitica, 'resourceType' | 'enabled'>): {
    sql: string;
    valores: unknown[];
  } {
    const partes: string[] = [];
    const valores: unknown[] = [];
    if (filtro.resourceType !== undefined) {
      valores.push(filtro.resourceType);
      partes.push(`resource_type = $${String(valores.length)}`);
    }
    if (filtro.enabled !== undefined) {
      valores.push(filtro.enabled);
      partes.push(`enabled = $${String(valores.length)}`);
    }
    return { sql: partes.length === 0 ? '' : ` WHERE ${partes.join(' AND ')}`, valores };
  }

  return {
    async criar(dados): Promise<Politica> {
      try {
        const { rows } = await pool.query<LinhaDePolitica>(
          `INSERT INTO policies
             (name, description, effect, resource_type, action, condition, priority, enabled)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING ${COLUNAS}`,
          [
            dados.name,
            dados.description,
            dados.effect,
            dados.resourceType,
            dados.action,
            JSON.stringify(dados.condition),
            dados.priority,
            dados.enabled,
          ],
        );
        return paraEntidade(rows[0] as LinhaDePolitica);
      } catch (erro) {
        if (ehConflitoDeNome(erro)) throw new ErroDeAbac('politica-conflito');
        throw erro;
      }
    },

    async buscarPorId(id): Promise<Politica | null> {
      const { rows } = await pool.query<LinhaDePolitica>(
        `SELECT ${COLUNAS} FROM policies WHERE id = $1`,
        [id],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async listar(filtro): Promise<Politica[]> {
      const { sql, valores } = condicaoDeFiltro(filtro);
      const { rows } = await pool.query<LinhaDePolitica>(
        `SELECT ${COLUNAS} FROM policies${sql}
          ORDER BY priority DESC, name
          LIMIT $${String(valores.length + 1)} OFFSET $${String(valores.length + 2)}`,
        [...valores, filtro.limite, filtro.offset],
      );
      return rows.map(paraEntidade);
    },

    async contar(filtro): Promise<number> {
      const { sql, valores } = condicaoDeFiltro(filtro);
      const { rows } = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM policies${sql}`,
        valores,
      );
      return Number(rows[0]?.total ?? '0');
    },

    async atualizar(id, dados): Promise<Politica | null> {
      try {
        const { rows } = await pool.query<LinhaDePolitica>(
          `UPDATE policies
              SET name = $2, description = $3, effect = $4, resource_type = $5,
                  action = $6, condition = $7::jsonb, priority = $8, enabled = $9
            WHERE id = $1
            RETURNING ${COLUNAS}`,
          [
            id,
            dados.name,
            dados.description,
            dados.effect,
            dados.resourceType,
            dados.action,
            JSON.stringify(dados.condition),
            dados.priority,
            dados.enabled,
          ],
        );
        const linha = rows[0];
        return linha === undefined ? null : paraEntidade(linha);
      } catch (erro) {
        if (ehConflitoDeNome(erro)) throw new ErroDeAbac('politica-conflito');
        throw erro;
      }
    },

    async remover(id): Promise<boolean> {
      const { rowCount } = await pool.query('DELETE FROM policies WHERE id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },

    async listarAplicaveis(resourceType, action): Promise<Politica[]> {
      const { rows } = await pool.query<LinhaDePolitica>(
        `SELECT ${COLUNAS} FROM policies
          WHERE enabled
            AND resource_type IN ($1, '*')
            AND action IN ($2, '*')
          ORDER BY priority DESC, name`,
        [resourceType, action],
      );
      return rows.map(paraEntidade);
    },
  };
}
