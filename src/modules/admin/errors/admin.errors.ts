/**
 * Erro de domínio do painel administrativo. O controller mapeia `codigo` para o status
 * RFC 7807; os serviços não conhecem HTTP.
 *
 * `sessao-propria` é 409 e não 403: o ator tem a permissão e a requisição está autorizada —
 * o que se recusa é o alvo. Encerrar a própria sessão no meio de uma operação administrativa
 * é acidente frequente o bastante para merecer uma recusa que aponta o caminho certo.
 */
export type CodigoDeErroDeAdmin =
  | 'usuario-nao-encontrado' // 404
  | 'sessao-nao-encontrada' // 404
  | 'sessao-propria' // 409
  | 'fonte-essencial-indisponivel'; // 503

export class ErroDeAdmin extends Error {
  public readonly codigo: CodigoDeErroDeAdmin;

  constructor(codigo: CodigoDeErroDeAdmin) {
    super(`ErroDeAdmin: ${codigo}`);
    this.name = 'ErroDeAdmin';
    this.codigo = codigo;
  }
}
