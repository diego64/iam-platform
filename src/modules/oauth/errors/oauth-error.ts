/**
 * Erro de domínio da superfície OAuth2. Carrega o código da RFC 6749 §5.2, que é o que o
 * cliente lê para decidir o que fazer.
 * Regras:
 *  - `descricao` é texto fixo por código. Nunca a mensagem original da exceção, nunca eco do
 *    corpo recebido, nunca o `client_id` digitado — a resposta de erro do endpoint de token é
 *    lida por quem está sondando credencial.
 *  - `invalid_client` é o único 401 (a RFC manda acompanhar de `WWW-Authenticate`); todo o
 *    resto é 400.
 */

export type CodigoDeErroOAuth =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope';

/** Texto padrão de cada código. Genérico de propósito — ver o cabeçalho. */
const DESCRICAO_PADRAO: Readonly<Record<CodigoDeErroOAuth, string>> = {
  invalid_request: 'Requisição malformada ou com parâmetro obrigatório ausente.',
  invalid_client: 'Falha na autenticação do cliente.',
  invalid_grant: 'Credencial inválida ou expirada.',
  unauthorized_client: 'O cliente não está autorizado a usar este grant.',
  unsupported_grant_type: 'Grant não suportado por este servidor.',
  invalid_scope: 'Escopo inválido, desconhecido ou fora do concedido.',
};

export class ErroDeOAuth extends Error {
  public readonly codigo: CodigoDeErroOAuth;
  public readonly descricao: string;
  public readonly status: number;

  constructor(codigo: CodigoDeErroOAuth, descricao?: string) {
    super(`ErroDeOAuth: ${codigo}`);
    this.name = 'ErroDeOAuth';
    this.codigo = codigo;
    this.descricao = descricao ?? DESCRICAO_PADRAO[codigo];
    this.status = codigo === 'invalid_client' ? 401 : 400;
  }
}
