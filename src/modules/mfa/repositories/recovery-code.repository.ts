/**
 * Responsabilidade: persistir e consumir os códigos de recuperação no PostgreSQL.
 * Consumido por: o serviço de MFA (geração, regeneração e verificação).
 * Regras:
 *  - Só o `sha256` do código canônico é gravado; o código em claro existe apenas na resposta
 *    que o entrega, uma única vez.
 *  - O consumo é `UPDATE ... WHERE used_at IS NULL`, e o resultado da própria escrita é a
 *    resposta: ler-depois-escrever deixaria dois pedidos simultâneos gastarem o mesmo código.
 *  - Regenerar apaga o conjunto inteiro, usados e não usados: o que o usuário guardou no
 *    papel deixa de valer quando ele pede códigos novos.
 */
import type { Pool } from 'pg';

export interface RepositorioDeCodigosDeRecuperacao {
  /** Troca o conjunto do usuário pelos hashes dados, numa transação. */
  substituir(userId: string, hashes: readonly string[]): Promise<void>;
  /** Gasta o código. `true` só para quem venceu a corrida; `false` se não existe ou já foi usado. */
  consumir(userId: string, hash: string): Promise<boolean>;
  /** Quantos ainda podem ser usados. */
  contarValidos(userId: string): Promise<number>;
  removerDoUsuario(userId: string): Promise<void>;
}

export function criarRepositorioDeCodigosDeRecuperacao(
  pool: Pool,
): RepositorioDeCodigosDeRecuperacao {
  return {
    async substituir(userId, hashes): Promise<void> {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
        if (hashes.length > 0) {
          await cliente.query(
            `INSERT INTO mfa_recovery_codes (user_id, code_hash)
             SELECT $1, unnest($2::text[])`,
            [userId, hashes],
          );
        }
        await cliente.query('COMMIT');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    },

    async consumir(userId, hash): Promise<boolean> {
      // A checagem de "ainda não usado" é a própria escrita — atômica por construção.
      const { rowCount } = await pool.query(
        `UPDATE mfa_recovery_codes SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [userId, hash],
      );
      return (rowCount ?? 0) > 0;
    },

    async contarValidos(userId): Promise<number> {
      const { rows } = await pool.query<{ total: string }>(
        'SELECT count(*) AS total FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [userId],
      );
      return Number(rows[0]?.total ?? 0);
    },

    async removerDoUsuario(userId): Promise<void> {
      await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    },
  };
}
