/**
 * Erro de domínio do módulo de senha. O controller (T11) mapeia `codigo` para o status
 * RFC 7807 correspondente; o serviço nunca conhece HTTP.
 *
 * As mensagens de credencial e de token são genéricas de propósito — a distinção real
 * (senha errada vs. usuário sumido, token inexistente vs. expirado vs. usado) fica só no
 * log, para não dar pista a quem sonda.
 */
export type CodigoDeErroDeSenha =
  | 'credencial-invalida' // 401 — senha atual errada
  | 'politica' // 400 — nova senha reprovada pela política
  | 'reuso' // 400 — nova senha igual à atual ou a uma recente
  | 'token-invalido'; // 400 — token de reset inexistente, expirado ou usado

export class ErroDeSenha extends Error {
  public readonly codigo: CodigoDeErroDeSenha;
  /** Detalhe adicional (ex.: o motivo da política) — seguro para expor, nunca a senha. */
  public readonly detalhe?: string;

  constructor(codigo: CodigoDeErroDeSenha, detalhe?: string) {
    super(`ErroDeSenha: ${codigo}`);
    this.name = 'ErroDeSenha';
    this.codigo = codigo;
    if (detalhe !== undefined) this.detalhe = detalhe;
  }
}
