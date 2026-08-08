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
  /** Permissões efetivas (claim `perm`); base do guard de autorização (SPEC 003). */
  readonly permissions: string[];
  readonly scope: string;
}

/** Par de tokens emitido no login. O refresh é opaco (o concreto vem do token persistente). */
export interface ParDeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiraEmSegundos: number;
}

/**
 * O login parou no primeiro fator: a senha conferiu, mas a conta exige um segundo passo.
 *
 * Não é erro — é metade do caminho feliz. Usar 401 aqui faria metade dos 401 de `/auth/login`
 * deixarem de significar falha, e o cliente teria de inspecionar o corpo para saber a
 * diferença. A união discriminada é o que o consumidor checa em um campo.
 */
export interface DesafioDeMfaPendente {
  readonly mfaRequerido: true;
  readonly mfaToken: string;
  readonly expiraEmSegundos: number;
}

export type ResultadoDeLogin = ParDeTokens | DesafioDeMfaPendente;

export function exigeSegundoFator(resultado: ResultadoDeLogin): resultado is DesafioDeMfaPendente {
  return 'mfaRequerido' in resultado;
}
