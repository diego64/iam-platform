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
  // Desafios de MFA — o estado do login que parou entre a senha e o segundo fator. Só o
  // sha256 do token opaco é gravado. TTL curto: um desafio que ninguém respondeu não deve
  // sobreviver ao intervalo em que a pessoa ainda está na tela.
  await banco.collection('mfa_challenges').createIndexes([
    { key: { token_hash: 1 }, unique: true },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
  ]);
  // Contadores de rate limit. A chave é o próprio `_id` (único e indexado por construção),
  // então o único índice a criar é o TTL: sem ele a coleção cresceria para sempre guardando
  // janelas que ninguém mais consulta.
  await banco
    .collection('rate_limit_counters')
    .createIndexes([{ key: { expires_at: 1 }, expireAfterSeconds: 0 }]);
  // Eventos de segurança — juízo derivado, com validade, separado da trilha de fatos. A
  // leitura padrão é por tempo decrescente; os outros dois índices cobrem o filtro por regra
  // e a investigação a partir de um sujeito. TTL porque conclusão expira: a regra de hoje
  // pode estar errada amanhã.
  await banco.collection('security_events').createIndexes([
    { key: { detectado_em: -1 } },
    { key: { regra: 1, detectado_em: -1 } },
    { key: { 'sujeito.pista': 1, detectado_em: -1 } },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 }, // TTL
  ]);
  // Conjuntos de valores distintos por janela (credential stuffing). A chave é o `_id`, e o
  // único índice a criar é o TTL.
  await banco
    .collection('security_distinct_sets')
    .createIndexes([{ key: { expires_at: 1 }, expireAfterSeconds: 0 }]);
  // Dispositivos já vistos por usuário (aviso de acesso novo). A chave é o `_id` — o digest
  // do dispositivo —, então o único índice a criar é o TTL. Ele é deslizante: `expires_at` é
  // regravado a cada aparição, para que quem usa o mesmo navegador todo dia não receba um
  // "novo dispositivo" falso a cada vencimento.
  await banco
    .collection('known_devices')
    .createIndexes([{ key: { expires_at: 1 }, expireAfterSeconds: 0 }]);
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
