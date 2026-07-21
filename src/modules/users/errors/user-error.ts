/**
 * Erro de domínio do módulo de usuário. O controller mapeia `codigo` para o status
 * RFC 7807; o serviço e o repositório nunca conhecem HTTP.
 *
 * `nao-encontrado` é deliberadamente genérico — não distingue "id nunca existiu" de
 * "id removido"; o admin autenticado não precisa dessa nuance e ela não deve vazar.
 */
export type CodigoDeErroDeUsuario =
  | 'email-conflito' // 409 — e-mail já cadastrado
  | 'nao-encontrado' // 404 — usuário inexistente
  | 'politica'; // 400 — senha reprovada pela política (defesa em profundidade no domínio)

export class ErroDeUsuario extends Error {
  public readonly codigo: CodigoDeErroDeUsuario;
  /** Motivo já sanitizado (ex.: mensagem da política) — seguro para expor, nunca a senha. */
  public readonly detalhe?: string;

  constructor(codigo: CodigoDeErroDeUsuario, detalhe?: string) {
    super(`ErroDeUsuario: ${codigo}`);
    this.name = 'ErroDeUsuario';
    this.codigo = codigo;
    if (detalhe !== undefined) this.detalhe = detalhe;
  }
}
