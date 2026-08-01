/**
 * Responsabilidade: garantir índices (unique + TTL) de refresh_tokens e token_denylist. Idempotente.
 * Regras: rodado no boot e na migração; não cria índices duplicados; TTL expira sozinho.
 */
import type { Db } from 'mongodb';

export async function garantirIndices(banco: Db): Promise<void> {
  await banco.collection('refresh_tokens').createIndexes([
    { key: { token_hash: 1 }, unique: true },
    { key: { user_id: 1 } },
    { key: { family_id: 1 } }, // revogação de família (logout, reuso, bloqueio) em O(família)
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL: expira sozinho
  ]);
  await banco.collection('token_denylist').createIndexes([
    { key: { jti: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
  ]);
  // Metadados de sessão (uma por família de refresh). Listadas pelo próprio dono e apagadas
  // sozinhas ao fim do teto absoluto da família.
  await banco.collection('active_sessions').createIndexes([
    { key: { session_id: 1 }, unique: true },
    { key: { user_id: 1, status: 1 } }, // listar as ativas de um usuário
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
  ]);
  // Tokens de reset de senha. Só o sha256 é indexado/único; o token em claro
  // nunca toca o banco. TTL apaga o registro ao expirar; o índice por user_id serve para
  // invalidar todos os tokens de um usuário quando ele troca a senha.
  await banco.collection('password_reset_tokens').createIndexes([
    { key: { token_sha256: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
    { key: { user_id: 1 } },
  ]);
}
