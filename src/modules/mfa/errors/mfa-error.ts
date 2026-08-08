/**
 * Erro de domínio do MFA. O controller mapeia cada motivo para um status distinto, com uma
 * exceção deliberada: tudo o que vem da verificação de um desafio (`desafio-invalido`) é uma
 * resposta só — desafio inexistente, expirado, com tentativas esgotadas e código errado são
 * indistinguíveis para quem chama, senão a resposta vira oráculo de sondagem.
 *
 * `credencial-invalida` repete a mensagem genérica do login: o step-up por senha não pode
 * distinguir "senha errada" de nada mais.
 */
export type MotivoDeErroDeMfa =
  | 'ja-habilitado'
  | 'cadastro-nao-encontrado'
  | 'codigo-invalido'
  | 'nao-habilitado'
  | 'desafio-invalido'
  | 'credencial-invalida'
  | 'usuario-nao-encontrado';

export class ErroDeMfa extends Error {
  public readonly motivo: MotivoDeErroDeMfa;

  constructor(motivo: MotivoDeErroDeMfa) {
    super(`ErroDeMfa: ${motivo}`);
    this.name = 'ErroDeMfa';
    this.motivo = motivo;
  }
}
