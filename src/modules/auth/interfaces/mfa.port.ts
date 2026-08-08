/**
 * Porta do segundo fator. O login precisa saber duas coisas — se esta conta exige um segundo
 * passo e se a resposta ao desafio confere — sem conhecer TOTP, código de recuperação nem os
 * repositórios que os guardam. O concreto entra por injeção; ausente, o login é de um passo
 * só, que é o comportamento de antes de existir MFA.
 */

export interface DesafioEmitido {
  /** Token opaco que o cliente devolve em `/auth/mfa/verify`. */
  readonly token: string;
  readonly expiraEmSegundos: number;
}

/** Como o segundo fator foi satisfeito — vira a claim `amr` do token emitido. */
export type MetodoDeMfa = 'otp' | 'recovery';

export interface DesafioResolvido {
  readonly userId: string;
  readonly metodo: MetodoDeMfa;
}

export interface RespostaAoDesafio {
  readonly codigo?: string | undefined;
  readonly codigoDeRecuperacao?: string | undefined;
}

export interface PortaDeMfa {
  /** `null` quando a conta não tem segundo fator ativo — o login segue direto. */
  desafiar(userId: string): Promise<DesafioEmitido | null>;
  /**
   * Consome o desafio. `null` para qualquer falha — desafio inexistente, expirado, com
   * tentativas esgotadas ou resposta errada. A distinção fica na métrica e no log; devolvê-la
   * ao chamador entregaria um oráculo a quem sonda desafios.
   */
  resolver(mfaToken: string, resposta: RespostaAoDesafio): Promise<DesafioResolvido | null>;
}
