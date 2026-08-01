/**
 * Porta do refresh token. A emissão/rotação/persistência do token opaco é de outro módulo;
 * aqui o login só precisa emitir um e o logout revogar. O concreto entra por injeção — um
 * stub cumpre o contrato enquanto o token persistente não existe.
 */
export interface PortaDeRefreshToken {
  /** Emite um refresh token opaco para o usuário. */
  emitir(userId: string): Promise<string>;
  /** Revoga o refresh token (no logout). */
  revogar(refreshToken: string): Promise<void>;
}
