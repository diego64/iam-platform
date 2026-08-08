/**
 * Responsabilidade: garantir os índices (unique, TTL e de consulta) das coleções do Mongo. Idempotente.
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
  // Tokens de reset de senha. Só o sha256 é indexado/único; o token em claro
  // nunca toca o banco. TTL apaga o registro ao expirar; o índice por user_id serve para
  // invalidar todos os tokens de um usuário quando ele troca a senha.
  await banco.collection('password_reset_tokens').createIndexes([
    { key: { token_sha256: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
    { key: { user_id: 1 } },
  ]);
  // Trilha de auditoria. `seq` único é o que denuncia buraco na cadeia, e `event_id` único
  // torna a reemissão do mesmo evento inofensiva. Os três índices de consulta cobrem os
  // filtros da leitura (tipo, ator, alvo), sempre com recorte por tempo.
  //
  // Deliberadamente SEM índice TTL: a trilha não expira sozinha. Um TTL apagaria o começo
  // da cadeia e a verificação de integridade passaria a acusar buraco todo dia; expurgo é
  // operação de runbook, com corte anunciado por checkpoint.
  await banco
    .collection('audit_log')
    .createIndexes([
      { key: { seq: 1 }, unique: true },
      { key: { event_id: 1 }, unique: true },
      { key: { occurred_at: -1 } },
      { key: { type: 1, occurred_at: -1 } },
      { key: { 'actor.id': 1, occurred_at: -1 }, sparse: true },
      { key: { 'target.id': 1, occurred_at: -1 }, sparse: true },
    ]);
}
