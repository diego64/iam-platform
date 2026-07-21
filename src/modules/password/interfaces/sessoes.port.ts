/**
 * Porta de revogação de sessões, chamada quando a senha muda.
 *
 * Trocar a senha sem derrubar as sessões existentes deixaria um invasor com sessão ativa
 * mesmo depois de o dono legítimo reagir. O concreto (denylist de tokens e listagem de
 * sessões ativas) ainda não existe; aqui só se declara o contrato e se exige a revogação
 * em toda troca/reset bem-sucedida.
 */
export interface RevogadorDeSessoes {
  revogarTodas(userId: string): Promise<void>;
}
