/**
 * Responsabilidade: extrair o par `client_id`/`client_secret` da requisição de token.
 * Consumido por: o `OAuthService`, antes de qualquer decisão sobre o grant.
 * Regras:
 *  - Dois métodos aceitos (RFC 6749 §2.3.1): `Authorization: Basic` — o preferido — e os
 *    campos no corpo. Usar os dois na mesma requisição é `invalid_request`, como a RFC exige:
 *    aceitar um deles em silêncio deixaria ambíguo qual credencial de fato autenticou.
 *  - Credencial ausente ou malformada é `invalid_client`, nunca uma mensagem que diferencie
 *    "faltou o header" de "o base64 está quebrado" — a resposta é lida por quem sonda.
 *  - Os campos do Basic vêm percent-encoded (RFC 6749 §2.3.1) e são decodificados; segredo
 *    com caractere reservado é o caso que quebra quando essa etapa é esquecida.
 */
import { ErroDeOAuth } from '../errors/oauth-error.js';

export interface CredencialDeCliente {
  readonly clientId: string;
  readonly secret: string;
}

export interface CamposDeCredencial {
  readonly client_id?: string | undefined;
  readonly client_secret?: string | undefined;
}

const PREFIXO_BASIC = 'basic ';
const BASE64_VALIDO = /^[A-Za-z0-9+/]*={0,2}$/;

function decodificarPercent(valor: string): string {
  try {
    return decodeURIComponent(valor);
  } catch {
    // Sequência `%` inválida: credencial malformada, não um segredo que por acaso não decodifica.
    throw new ErroDeOAuth('invalid_client');
  }
}

/** Lê o header `Authorization: Basic`. Devolve `null` quando o header não é Basic. */
function lerBasic(cabecalho: string | undefined): CredencialDeCliente | null {
  if (cabecalho === undefined || !cabecalho.toLowerCase().startsWith(PREFIXO_BASIC)) {
    return null;
  }

  const codificado = cabecalho.slice(PREFIXO_BASIC.length).trim();
  // O Buffer ignora caractere inválido em vez de falhar, então a validação vem antes.
  if (codificado.length === 0 || !BASE64_VALIDO.test(codificado)) {
    throw new ErroDeOAuth('invalid_client');
  }

  const decodificado = Buffer.from(codificado, 'base64').toString('utf8');
  const separador = decodificado.indexOf(':');
  if (separador === -1) {
    throw new ErroDeOAuth('invalid_client');
  }

  return {
    clientId: decodificarPercent(decodificado.slice(0, separador)),
    secret: decodificarPercent(decodificado.slice(separador + 1)),
  };
}

/**
 * Devolve a credencial apresentada, de qualquer um dos dois métodos.
 * @throws {ErroDeOAuth} `invalid_request` quando os dois métodos vêm juntos;
 *         `invalid_client` quando não vem nenhum ou o Basic está malformado.
 */
export function extrairCredencialDeCliente(
  cabecalhoAuthorization: string | undefined,
  corpo: CamposDeCredencial,
): CredencialDeCliente {
  const doBasic = lerBasic(cabecalhoAuthorization);
  const noCorpo = corpo.client_id !== undefined || corpo.client_secret !== undefined;

  if (doBasic !== null && noCorpo) {
    throw new ErroDeOAuth('invalid_request', 'Use um único método de autenticação de cliente.');
  }

  if (doBasic !== null) {
    return doBasic;
  }

  if (corpo.client_id === undefined || corpo.client_secret === undefined) {
    throw new ErroDeOAuth('invalid_client');
  }

  return { clientId: corpo.client_id, secret: corpo.client_secret };
}
