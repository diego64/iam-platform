/**
 * Porta do refresh token. A emissão/rotação/persistência do token opaco é de outro módulo;
 * aqui o login só precisa emitir um e o logout revogar. O concreto entra por injeção — um
 * stub cumpre o contrato enquanto o token persistente não existe.
 */

/** Origem da emissão. Ausente, o token nasce solto — a sessão do login por senha. */
export interface ContextoDeEmissao {
  /**
   * Cliente dono do token. É o que impede um cliente de resgatar o refresh de outro: na
   * rotação, o vínculo é comparado com quem se autenticou, e `null` só casa com `null`.
   */
  readonly clientId?: string | null;
  /** Escopo concedido na emissão; a rotação não pode ampliá-lo. */
  readonly escopo?: string | null;
  /**
   * Como o sujeito se autenticou nesta família. Viaja com ela porque, sem isso, a primeira
   * renovação transformaria uma sessão de dois fatores numa que **diz** ter um só — e
   * qualquer política que exija fator forte passaria a falhar 15 minutos depois do login.
   */
  readonly amr?: readonly string[] | null;
}

export interface PortaDeRefreshToken {
  /** Emite um refresh token opaco para o usuário. */
  emitir(userId: string, contexto?: ContextoDeEmissao): Promise<string>;
  /** Revoga o refresh token (no logout). */
  revogar(refreshToken: string): Promise<void>;
}
