/**
 * Responsabilidade: a denylist de access tokens revogados, no MongoDB.
 * Consumido por: o `AuthService` (logout) e o middleware `verificarAccessToken`.
 * Regras:
 *  - Recebe o `Db` por injeção. Índices (unique jti + TTL em expires_at) são de indexes.ts.
 *  - `revogar` é idempotente (upsert por jti): revogar o mesmo token duas vezes não falha.
 *  - `estaRevogado` propaga erro do driver — o middleware trata como fail closed (rejeita o
 *    token), nunca deixa passar por indisponibilidade do Mongo.
 */
import type { Db } from 'mongodb';

export type MotivoDeRevogacao = 'logout' | 'blocked' | 'admin_revoke';

export interface EntradaDeRevogacao {
  readonly jti: string;
  readonly userId: string;
  readonly motivo: MotivoDeRevogacao;
  /** `exp` do token: quando o TTL do Mongo apaga o registro sozinho. */
  readonly expiraEm: Date;
}

export interface RepositorioDeDenylist {
  revogar(entrada: EntradaDeRevogacao): Promise<void>;
  estaRevogado(jti: string): Promise<boolean>;
}

interface DocDenylist {
  readonly jti: string;
  readonly user_id: string;
  readonly reason: MotivoDeRevogacao;
  readonly expires_at: Date;
}

export function criarRepositorioDeDenylist(banco: Db): RepositorioDeDenylist {
  const colecao = banco.collection<DocDenylist>('token_denylist');

  return {
    async revogar(entrada: EntradaDeRevogacao): Promise<void> {
      await colecao.updateOne(
        { jti: entrada.jti },
        {
          $setOnInsert: {
            jti: entrada.jti,
            user_id: entrada.userId,
            reason: entrada.motivo,
            expires_at: entrada.expiraEm,
          },
        },
        { upsert: true },
      );
    },

    async estaRevogado(jti: string): Promise<boolean> {
      const doc = await colecao.findOne({ jti }, { projection: { _id: 1 } });
      return doc !== null;
    },
  };
}
