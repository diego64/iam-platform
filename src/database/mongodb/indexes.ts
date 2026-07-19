/**
 * Responsabilidade: garantir índices (unique + TTL) de refresh_tokens e token_denylist. Idempotente.
 * Regras: rodado no boot e na migração; não cria índices duplicados; TTL expira sozinho.
 */
import type { Db } from 'mongodb';

export async function garantirIndices(banco: Db): Promise<void> {
  await banco.collection('refresh_tokens').createIndexes([
    { key: { token_hash: 1 }, unique: true },
    { key: { user_id: 1 } },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL: expira sozinho
  ]);
  await banco.collection('token_denylist').createIndexes([
    { key: { jti: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
  ]);
}
