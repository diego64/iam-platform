/**
 * Responsabilidade: o vocabulário fechado da trilha — tipos de evento e motivos.
 * Consumido por: quem registra evento (todos os módulos) e a borda HTTP de leitura.
 * Regras:
 *  - União literal, não `string`: tipo novo é mudança de código revisada, e o compilador
 *    acha quem emite. Texto livre viraria vocabulário divergente em três meses.
 *  - `motivo` também é fechado porque ele descreve **por que** a operação falhou, e
 *    repassar a mensagem original arrastaria e-mail digitado ou erro de driver para dentro
 *    de uma coleção que não expira.
 */

export const TIPOS_DE_EVENTO = [
  'iam.auth.login',
  'iam.auth.login_failed',
  'iam.auth.logout',
  'iam.token.refreshed',
  'iam.token.reuse_detected',
  'iam.password.changed',
  'iam.password.reset_requested',
  'iam.password.reset_completed',
  'iam.user.created',
  'iam.user.updated',
  'iam.user.blocked',
  'iam.user.unblocked',
  'iam.user.deleted',
  'iam.role.assigned',
  'iam.role.revoked',
  'iam.role.permission_granted',
  'iam.session.revoked',
  'iam.mfa.enrolled',
  'iam.mfa.verified',
  'iam.mfa.failed',
  'iam.mfa.recovery_used',
  'iam.mfa.disabled',
  'iam.mfa.reset',
  'iam.client.created',
  'iam.client.secret_rotated',
  'iam.oauth.token_issued',
  'iam.oauth.token_denied',
  'iam.key.rotated',
] as const;

export type TipoDeEvento = (typeof TIPOS_DE_EVENTO)[number];

const CONJUNTO_DE_TIPOS: ReadonlySet<string> = new Set(TIPOS_DE_EVENTO);

/** Guarda de tipo para a borda HTTP, que recebe o filtro como string. */
export function ehTipoDeEvento(valor: string): valor is TipoDeEvento {
  return CONJUNTO_DE_TIPOS.has(valor);
}

export const MOTIVOS_DE_EVENTO = [
  'invalid_credentials',
  'account_blocked',
  'token_expired',
  'token_revoked',
  'token_reused',
  'policy_violation',
  'admin_action',
  'self_service',
  'rotation_scheduled',
] as const;

export type MotivoDeEvento = (typeof MOTIVOS_DE_EVENTO)[number];

export type TipoDeAtor = 'user' | 'client' | 'system';
export type TipoDeAlvo = 'user' | 'role' | 'client' | 'key' | 'session';
export type ResultadoDeEvento = 'success' | 'failure';

/**
 * Chaves proibidas em `metadata`, casadas por substring no nome já em minúsculas.
 *
 * A trilha não expira; um segredo que entre aqui fica para sempre. A checagem é por
 * substring de propósito: `password_hash`, `refresh_token` e `client_secret_hash` casam
 * todos por `password`, `token` e `secret`, sem precisar prever cada nome futuro.
 */
export const FRAGMENTOS_PROIBIDOS_EM_METADATA = [
  'senha',
  'password',
  'token',
  'secret',
  'segredo',
  'hash',
  'authorization',
  'private_key',
] as const;
