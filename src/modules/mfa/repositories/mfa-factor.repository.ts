/**
 * Responsabilidade: persistir o fator TOTP de um usuário no PostgreSQL.
 * Consumido por: o serviço de MFA (cadastro, confirmação, verificação, desativação).
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão.
 *  - O segredo trafega cifrado (blob do envelope); este repositório não cifra nem decifra,
 *    só guarda o que recebe. Quem tem a `MASTER_KEY` é o serviço.
 *  - `registrarUso` só avança `last_step`: o `WHERE last_step IS NULL OR last_step < $2` é o
 *    que impede uma requisição atrasada reabrir um passo já consumido e devolver a janela de
 *    replay que o anti-replay fechou.
 */
import type { Pool } from 'pg';

export type StatusDoFator = 'pending' | 'active';

export interface FatorDeMfa {
  readonly id: string;
  readonly userId: string;
  readonly status: StatusDoFator;
  readonly segredoCifrado: Buffer;
  readonly label: string | null;
  readonly ultimoPasso: number | null;
  readonly confirmadoEm: Date | null;
  readonly ultimoUsoEm: Date | null;
}

export interface RepositorioDeFatorDeMfa {
  /** Fator ativo do usuário, ou `null` quando ele não tem segundo fator. */
  buscarAtivo(userId: string): Promise<FatorDeMfa | null>;
  /** Cadastro pendente do usuário, ou `null`. */
  buscarPendente(userId: string): Promise<FatorDeMfa | null>;
  /** Substitui o pendente anterior e grava um novo. */
  criarPendente(entrada: {
    userId: string;
    segredoCifrado: Buffer;
    label: string | null;
  }): Promise<FatorDeMfa>;
  /** Ativa o pendente. `false` quando não havia pendente para ativar. */
  ativar(id: string, passo: number): Promise<boolean>;
  /** Avança o passo consumido e marca o uso. Nunca retrocede. */
  registrarUso(id: string, passo: number): Promise<void>;
  /** Remove fator ativo e pendente do usuário. Devolve quantos saíram. */
  removerDoUsuario(userId: string): Promise<number>;
}

interface LinhaDeFator {
  readonly id: string;
  readonly user_id: string;
  readonly status: StatusDoFator;
  readonly secret_encrypted: Buffer;
  readonly label: string | null;
  readonly last_step: string | null;
  readonly confirmed_at: Date | null;
  readonly last_used_at: Date | null;
}

const COLUNAS =
  'id, user_id, status, secret_encrypted, label, last_step, confirmed_at, last_used_at';

function paraDominio(linha: LinhaDeFator): FatorDeMfa {
  return {
    id: linha.id,
    userId: linha.user_id,
    status: linha.status,
    segredoCifrado: linha.secret_encrypted,
    label: linha.label,
    // BIGINT chega como texto do driver: converter aqui evita comparar número com string
    // lá na frente, no lugar onde a comparação decide se um código vale.
    ultimoPasso: linha.last_step === null ? null : Number(linha.last_step),
    confirmadoEm: linha.confirmed_at,
    ultimoUsoEm: linha.last_used_at,
  };
}

export function criarRepositorioDeFatorDeMfa(pool: Pool): RepositorioDeFatorDeMfa {
  async function buscarPorStatus(
    userId: string,
    status: StatusDoFator,
  ): Promise<FatorDeMfa | null> {
    const { rows } = await pool.query<LinhaDeFator>(
      `SELECT ${COLUNAS} FROM user_mfa_factors WHERE user_id = $1 AND status = $2`,
      [userId, status],
    );
    const linha = rows[0];
    return linha === undefined ? null : paraDominio(linha);
  }

  return {
    buscarAtivo: (userId) => buscarPorStatus(userId, 'active'),
    buscarPendente: (userId) => buscarPorStatus(userId, 'pending'),

    async criarPendente(entrada): Promise<FatorDeMfa> {
      // Substituir em vez de acumular: recomeçar o cadastro é o caminho de quem trocou de
      // telefone no meio do processo, e dois pendentes violariam o índice parcial.
      await pool.query(`DELETE FROM user_mfa_factors WHERE user_id = $1 AND status = 'pending'`, [
        entrada.userId,
      ]);
      const { rows } = await pool.query<LinhaDeFator>(
        `INSERT INTO user_mfa_factors (user_id, secret_encrypted, label)
         VALUES ($1, $2, $3) RETURNING ${COLUNAS}`,
        [entrada.userId, entrada.segredoCifrado, entrada.label],
      );
      return paraDominio(rows[0] as LinhaDeFator);
    },

    async ativar(id, passo): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE user_mfa_factors
            SET status = 'active', confirmed_at = now(), last_step = $2, last_used_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id, passo],
      );
      return (rowCount ?? 0) > 0;
    },

    async registrarUso(id, passo): Promise<void> {
      await pool.query(
        `UPDATE user_mfa_factors
            SET last_step = $2, last_used_at = now()
          WHERE id = $1 AND (last_step IS NULL OR last_step < $2)`,
        [id, passo],
      );
    },

    async removerDoUsuario(userId): Promise<number> {
      const { rowCount } = await pool.query('DELETE FROM user_mfa_factors WHERE user_id = $1', [
        userId,
      ]);
      return rowCount ?? 0;
    },
  };
}
