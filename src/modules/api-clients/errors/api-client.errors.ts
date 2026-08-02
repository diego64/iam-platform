/**
 * Erro de domínio dos clientes de API. O controller mapeia `codigo` para o status
 * RFC 7807; serviço e repositório nunca conhecem HTTP.
 *
 * `escopo-desconhecido` carrega quais escopos faltaram: sem isso o operador recebe um 422
 * cego e tem que descobrir por eliminação qual dos vinte nomes está errado. Os nomes
 * pedidos não são sensíveis — são permissões do catálogo, que a rota de permissões já lista.
 */
export type CodigoDeErroDeCliente =
  | 'cliente-nao-encontrado' // 404
  | 'cliente-ja-removido' // 409
  | 'nome-em-uso' // 409
  | 'curinga-proibido' // 409
  | 'sem-segredo-anterior' // 409
  | 'escopo-desconhecido'; // 422

export class ErroDeCliente extends Error {
  public readonly codigo: CodigoDeErroDeCliente;
  /** Escopos que não existem no catálogo. Só acompanha `escopo-desconhecido`. */
  public readonly escoposDesconhecidos: readonly string[];

  constructor(codigo: CodigoDeErroDeCliente, escoposDesconhecidos: readonly string[] = []) {
    super(`ErroDeCliente: ${codigo}`);
    this.name = 'ErroDeCliente';
    this.codigo = codigo;
    this.escoposDesconhecidos = escoposDesconhecidos;
  }
}
