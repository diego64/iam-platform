/**
 * Porta de entrega do token de reset ao usuário.
 *
 * O concreto (e-mail) é da 019. Até lá, um canal de log-fallback mantém o fluxo íntegro
 * sem entregar nada de verdade — ver `canal-de-log.ts`. A porta recebe o token em claro
 * porque é o único ponto do sistema autorizado a vê-lo: o que persiste é sempre o sha256.
 */
export interface CanalDeNotificacao {
  enviarReset(email: string, token: string): Promise<void>;
}
