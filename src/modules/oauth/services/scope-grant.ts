/**
 * Responsabilidade: decidir quais escopos um token emitido pelo endpoint de OAuth carrega.
 * Consumido por: os três grants do `OAuthService`.
 * Regras:
 *  - A autoridade concedida é a interseção de três conjuntos: o que foi pedido, o que o
 *    cliente tem e o que o sujeito tem. Sem essa interseção, um cliente de escopo mínimo
 *    trocaria a senha de um superadmin por um token com autoridade total.
 *  - As duas bordas se comportam diferente de propósito. Pedir escopo que o **cliente** não
 *    tem é erro de configuração e vira `invalid_scope`; pedir escopo que o **usuário** não tem
 *    é cortado em silêncio, porque recusar revelaria as permissões daquele usuário a quem só
 *    tem a senha dele. A RFC 6749 §5.1 prevê exatamente isso: devolver o `scope` efetivo
 *    quando ele difere do pedido.
 *  - O curinga é expandido só do lado do sujeito: escopo de cliente é sempre concreto
 *    (`recurso:acao`), mas permissão de usuário pode ser `recurso:*` ou `*`. A semântica é a
 *    mesma do guard de autorização — dois significados para a mesma string seria pior que
 *    duplicar três linhas.
 */
import { ErroDeOAuth } from '../errors/oauth-error.js';

export interface EntradaDeEscopo {
  /** O que o cliente pediu. Vazio ou ausente ⇒ pede tudo o que ele tem. */
  readonly solicitados?: readonly string[] | undefined;
  readonly escoposDoCliente: readonly string[];
  /**
   * Autoridade de quem o token representa: as permissões efetivas do usuário no grant
   * `password`, ou os próprios escopos do cliente no `client_credentials`.
   */
  readonly autoridadeDoSujeito: readonly string[];
}

/** `true` se a autoridade cobre o escopo — diretamente, por curinga de recurso ou por `*`. */
function sujeitoCobre(autoridade: ReadonlySet<string>, escopo: string): boolean {
  if (autoridade.has('*') || autoridade.has(escopo)) return true;

  const separador = escopo.indexOf(':');
  if (separador === -1) return false;
  return autoridade.has(`${escopo.slice(0, separador)}:*`);
}

/**
 * Devolve os escopos concedidos, em ordem estável e sem repetição.
 * @throws {ErroDeOAuth} `invalid_scope` quando o pedido excede o cliente ou quando a
 *         interseção fica vazia — token sem autoridade nenhuma não é emitido, é erro.
 */
export function calcularEscopoConcedido(entrada: EntradaDeEscopo): readonly string[] {
  const doCliente = new Set(entrada.escoposDoCliente);
  const pediuAlgo = entrada.solicitados !== undefined && entrada.solicitados.length > 0;
  const base = pediuAlgo ? [...new Set(entrada.solicitados)] : [...doCliente];

  if (pediuAlgo) {
    const excedentes = base.filter((escopo) => !doCliente.has(escopo));
    if (excedentes.length > 0) {
      throw new ErroDeOAuth('invalid_scope', 'Escopo solicitado fora dos escopos do cliente.');
    }
  }

  const doSujeito = new Set(entrada.autoridadeDoSujeito);
  const concedidos = base.filter((escopo) => sujeitoCobre(doSujeito, escopo));

  if (concedidos.length === 0) {
    throw new ErroDeOAuth('invalid_scope', 'Nenhum escopo concedível para este sujeito.');
  }

  return concedidos;
}

/** Formato da claim `scope` e do campo de resposta: nomes separados por espaço (RFC 6749). */
export function formatarEscopo(escopos: readonly string[]): string {
  return escopos.join(' ');
}
