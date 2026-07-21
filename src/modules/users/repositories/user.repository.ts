/**
 * Responsabilidade: acesso à tabela `users` em PostgreSQL — o concreto por trás da porta
 * `RepositorioDeUsuario` da 009 e do CRUD desta SPEC.
 * Consumido por: o `UserService` (CRUD) e o módulo de senha (via a porta da 009).
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão (CLAUDE.md).
 *  - SQL sempre parametrizado (`$1..$n`); zero interpolação de string.
 *  - Seleciona colunas nominais; nada de `SELECT *` — o hash não escapa por descuido, e
 *    coluna nova na tabela não vaza sozinha para cima.
 *  - `updated_at = now()` explícito em todo UPDATE: a `0001` não tem trigger.
 */
import type { Pool } from 'pg';
import type { StatusDeUsuario, Usuario } from '../entities/user.entity.js';
import { ErroDeUsuario } from '../errors/user-error.js';

/** Código SQLSTATE de violação de unicidade — o UNIQUE(email) da `0001`. */
const VIOLACAO_UNICIDADE = '23505';

interface LinhaDeUsuario {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  readonly password_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Colunas fixas devolvidas por toda consulta — inclui `password_hash` para a porta da 009. */
const COLUNAS = 'id, email, status, password_hash, created_at, updated_at';

function paraEntidade(linha: LinhaDeUsuario): Usuario {
  return {
    id: linha.id,
    email: linha.email,
    status: linha.status,
    passwordHash: linha.password_hash,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

/** `true` quando o erro do `pg` é a violação do UNIQUE(email). */
function ehConflitoDeEmail(erro: unknown): boolean {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { code?: unknown }).code === VIOLACAO_UNICIDADE
  );
}

export interface FiltroDeListagem {
  readonly limite: number;
  readonly offset: number;
  readonly status?: StatusDeUsuario;
}

export interface RepositorioDeUsuario {
  // Porta da 009 (o módulo de senha depende destas três):
  buscarPorEmail(email: string): Promise<Usuario | null>;
  buscarPorId(id: string): Promise<Usuario | null>;
  atualizarHash(userId: string, novoHash: string): Promise<void>;
  // CRUD desta SPEC:
  criar(entrada: { email: string; passwordHash: string }): Promise<Usuario>;
  listar(filtro: FiltroDeListagem): Promise<Usuario[]>;
  contar(status?: StatusDeUsuario): Promise<number>;
  atualizarEmail(id: string, email: string): Promise<Usuario | null>;
  definirStatus(id: string, status: StatusDeUsuario): Promise<Usuario | null>;
  remover(id: string): Promise<boolean>;
}

export function criarRepositorioDeUsuario(pool: Pool): RepositorioDeUsuario {
  return {
    async buscarPorEmail(email: string): Promise<Usuario | null> {
      const { rows } = await pool.query<LinhaDeUsuario>(
        `SELECT ${COLUNAS} FROM users WHERE email = $1`,
        [email],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async buscarPorId(id: string): Promise<Usuario | null> {
      const { rows } = await pool.query<LinhaDeUsuario>(
        `SELECT ${COLUNAS} FROM users WHERE id = $1`,
        [id],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async atualizarHash(userId: string, novoHash: string): Promise<void> {
      await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
        userId,
        novoHash,
      ]);
    },

    async criar(entrada: { email: string; passwordHash: string }): Promise<Usuario> {
      try {
        const { rows } = await pool.query<LinhaDeUsuario>(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${COLUNAS}`,
          [entrada.email, entrada.passwordHash],
        );
        // O INSERT ... RETURNING sempre devolve a linha criada; o não-nulo é garantido.
        return paraEntidade(rows[0] as LinhaDeUsuario);
      } catch (erro) {
        if (ehConflitoDeEmail(erro)) throw new ErroDeUsuario('email-conflito');
        throw erro;
      }
    },

    async listar(filtro: FiltroDeListagem): Promise<Usuario[]> {
      // Filtro de status opcional sem montar SQL condicional: `$3 IS NULL OR status = $3`
      // trata "sem filtro" e "com filtro" na mesma query parametrizada.
      const { rows } = await pool.query<LinhaDeUsuario>(
        `SELECT ${COLUNAS} FROM users
         WHERE ($3::text IS NULL OR status = $3)
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [filtro.limite, filtro.offset, filtro.status ?? null],
      );
      return rows.map(paraEntidade);
    },

    async contar(status?: StatusDeUsuario): Promise<number> {
      const { rows } = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM users WHERE ($1::text IS NULL OR status = $1)',
        [status ?? null],
      );
      return Number(rows[0]?.total ?? '0');
    },

    async atualizarEmail(id: string, email: string): Promise<Usuario | null> {
      try {
        const { rows } = await pool.query<LinhaDeUsuario>(
          `UPDATE users SET email = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUNAS}`,
          [id, email],
        );
        const linha = rows[0];
        return linha === undefined ? null : paraEntidade(linha);
      } catch (erro) {
        if (ehConflitoDeEmail(erro)) throw new ErroDeUsuario('email-conflito');
        throw erro;
      }
    },

    async definirStatus(id: string, status: StatusDeUsuario): Promise<Usuario | null> {
      const { rows } = await pool.query<LinhaDeUsuario>(
        `UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUNAS}`,
        [id, status],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async remover(id: string): Promise<boolean> {
      const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },
  };
}
