/**
 * Erro de domínio do módulo de RBAC. O controller mapeia `codigo` para o status
 * RFC 7807; serviço e repositório nunca conhecem HTTP.
 *
 * `sistema-*` cobre a regra de imutabilidade: papéis e permissões marcados `is_system`
 * (o seed da 0004) não podem ser renomeados nem removidos — 409, não 403, porque a
 * requisição está autorizada; é o alvo que é protegido.
 */
export type CodigoDeErroDeRbac =
  | 'papel-nao-encontrado' // 404
  | 'permissao-nao-encontrada' // 404
  | 'usuario-nao-encontrado' // 404
  | 'papel-conflito' // 409 — name de papel já existe
  | 'permissao-conflito' // 409 — name de permissão já existe
  | 'papel-imutavel' // 409 — papel is_system
  | 'permissao-imutavel'; // 409 — permissão is_system

export class ErroDeRbac extends Error {
  public readonly codigo: CodigoDeErroDeRbac;

  constructor(codigo: CodigoDeErroDeRbac) {
    super(`ErroDeRbac: ${codigo}`);
    this.name = 'ErroDeRbac';
    this.codigo = codigo;
  }
}
