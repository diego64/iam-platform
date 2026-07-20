/**
 * Porta de revogação de sessões, chamada quando a senha muda.
 *
 * Trocar a senha sem derrubar as sessões existentes deixaria um invasor com sessão ativa
 * mesmo depois de o dono legítimo reagir. O concreto é da 001/006 (denylist + sessões
 * ativas); a 009 só declara o contrato e o exige em toda troca/reset bem-sucedida.
 */
export interface RevogadorDeSessoes {
  revogarTodas(userId: string): Promise<void>;
}
