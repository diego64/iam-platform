/**
 * Erro de domínio das sessões. O controller mapeia para 404 `session-not-found`.
 *
 * Uma sessão inexistente e uma sessão de outro usuário produzem o **mesmo** erro: quem
 * revoga por id nunca distingue "não existe" de "não é sua", para não dar pista de quais
 * sessões existem.
 */
export class ErroDeSessaoNaoEncontrada extends Error {
  constructor() {
    super('ErroDeSessaoNaoEncontrada');
    this.name = 'ErroDeSessaoNaoEncontrada';
  }
}
