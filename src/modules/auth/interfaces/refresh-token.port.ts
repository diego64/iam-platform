/**
 * Porta do refresh token. A emissão/rotação/persistência do token opaco é de outro módulo;
 * aqui o login só precisa emitir um e o logout revogar. O concreto entra por injeção.
 *
 * A emissão devolve, além do token, o identificador da sessão a que ele pertence — o login
 * precisa dele para colocar `sid` no access token e para o dono conseguir enxergar e encerrar
 * a sessão depois. O contexto (endereço de origem e agente) é o que descreve a sessão a quem
 * a lista.
 */

/** Origem de uma sessão, capturada no login para exibição posterior. */
export interface ContextoDeSessao {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Resultado da emissão: o token opaco e o identificador da sessão criada. */
export interface RefreshEmitido {
  readonly token: string;
  readonly sessionId: string;
}

export interface PortaDeRefreshToken {
  /** Emite um refresh token opaco, abrindo uma sessão nova para o usuário. */
  emitir(userId: string, contexto: ContextoDeSessao): Promise<RefreshEmitido>;
  /** Revoga o refresh token (no logout), encerrando a sessão inteira. */
  revogar(refreshToken: string): Promise<void>;
}
