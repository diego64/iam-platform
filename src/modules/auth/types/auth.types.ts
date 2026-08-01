/**
 * Responsabilidade: os tipos do domínio de autenticação, compartilhados entre serviço,
 * middleware e borda HTTP.
 * Regras: nada de Fastify nem de driver de banco aqui.
 */

/** Claims do access token além dos temporais (iat/exp) e de emissor/audiência. */
export interface CargaDoToken {
  readonly sub: string;
  readonly jti: string;
  readonly scope: string;
  readonly roles: string[];
}

/** Usuário resolvido a partir de um access token válido — anexado à requisição. */
export interface UsuarioAutenticado {
  readonly id: string;
  readonly roles: string[];
  readonly scope: string;
}

/** Par de tokens emitido no login. O refresh é opaco (o concreto é da SPEC 005). */
export interface ParDeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiraEmSegundos: number;
}
