/**
 * Responsabilidade: histórico de hashes de senha em PostgreSQL (tabela password_history).
 * Consumido por: o PasswordService, via porta `RepositorioDeHistoricoDeSenha`.
 * Regras: recebe o `Pool` por injeção (ADR-0001); guarda só hashes, nunca a senha.
 */
import type { Pool } from 'pg';
import type { RepositorioDeHistoricoDeSenha } from '../interfaces/historico.port.js';

export function criarRepositorioDeHistorico(pool: Pool): RepositorioDeHistoricoDeSenha {
  return {
    async ultimosHashes(userId: string, n: number): Promise<string[]> {
      const { rows } = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM password_history
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, n],
      );
      return rows.map((r) => r.password_hash);
    },

    async registrar(userId: string, hash: string): Promise<void> {
      await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [
        userId,
        hash,
      ]);
    },
  };
}
