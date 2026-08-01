/**
 * Erro de domínio do módulo de autenticação. O controller e o middleware mapeiam `codigo`
 * para o status RFC 7807; serviço e repositório nunca conhecem HTTP.
 *
 * `credencial-invalida` é deliberadamente único para qualquer falha de login (usuário
 * inexistente, senha errada, conta bloqueada): a distinção real fica só no log, para não
 * dar pista a quem sonda por enumeração de contas.
 */
export type CodigoDeErroDeAutenticacao =
  | 'credencial-invalida' // 401 — login falhou (motivo genérico)
  | 'token-invalido' // 401 — access token ausente/malformado/assinatura/exp/iss/aud
  | 'token-revogado'; // 401 — jti na denylist

export class ErroDeAutenticacao extends Error {
  public readonly codigo: CodigoDeErroDeAutenticacao;

  constructor(codigo: CodigoDeErroDeAutenticacao) {
    super(`ErroDeAutenticacao: ${codigo}`);
    this.name = 'ErroDeAutenticacao';
    this.codigo = codigo;
  }
}
