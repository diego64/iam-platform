/**
 * Erro de domínio da rotação de chaves. O controller mapeia `codigo` para o status
 * RFC 7807; serviço e repositório nunca conhecem HTTP.
 *
 * Todos os códigos são 409: a requisição está autorizada e bem formada, é o estado do
 * conjunto de chaves que não permite a operação agora. `chave-nao-encontrada` é a exceção,
 * um 404.
 */
export type CodigoDeErroDeRotacao =
  | 'chave-nao-encontrada' // 404
  | 'sem-chave-proxima' // 409 — nada pré-publicado para promover
  | 'chave-proxima-recente' // 409 — pré-publicada, mas consumidores podem não a conhecer
  | 'rotacao-em-andamento' // 409 — outra réplica segura o lock
  | 'chave-ja-revogada'; // 409 — já parou de verificar

export class ErroDeRotacao extends Error {
  public readonly codigo: CodigoDeErroDeRotacao;
  /**
   * Instante a partir do qual a promoção passa a ser aceita. Só acompanha
   * `chave-proxima-recente` — sem ele o operador não sabe quanto esperar.
   */
  public readonly rotacionavelEm: Date | undefined;

  constructor(codigo: CodigoDeErroDeRotacao, rotacionavelEm?: Date) {
    super(`ErroDeRotacao: ${codigo}`);
    this.name = 'ErroDeRotacao';
    this.codigo = codigo;
    this.rotacionavelEm = rotacionavelEm;
  }
}
