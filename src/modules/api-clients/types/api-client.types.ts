/**
 * Responsabilidade: os tipos do domínio de clientes de API.
 * Regras: o segredo em claro não aparece em tipo nenhum daqui — ele existe apenas no
 * retorno da criação/rotação e na única resposta HTTP que o entrega. Os hashes ficam
 * isolados em `CredenciaisDoCliente`, que só o caminho de autenticação enxerga.
 */

export type StatusDoCliente = 'active' | 'disabled' | 'deleted';

export type TipoDeGrant = 'client_credentials' | 'password' | 'refresh_token';

export const GRANTS_SUPORTADOS: readonly TipoDeGrant[] = [
  'client_credentials',
  'password',
  'refresh_token',
];

/** O cliente como a administração o enxerga — sem nada que sirva para autenticar. */
export interface ClienteDeApi {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: StatusDoCliente;
  /** Nomes de permissão do catálogo do RBAC concedidos a este cliente. */
  readonly escopos: readonly string[];
  readonly grantTypes: readonly TipoDeGrant[];
  /** `null` usa o TTL global de access token. */
  readonly accessTokenTtlSegundos: number | null;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
  readonly ultimoUsoEm: Date | null;
  readonly segredoRotacionadoEm: Date | null;
  readonly segredoAnteriorExpiraEm: Date | null;
}

/**
 * O que o caminho de autenticação precisa — inclui os hashes.
 *
 * Tipo separado, e não um campo opcional em `ClienteDeApi`, porque a separação é o que
 * garante que o hash não viaje por engano para um DTO de resposta: quem monta resposta
 * recebe `ClienteDeApi`, e ali o campo não existe.
 */
export interface CredenciaisDoCliente {
  readonly id: string;
  readonly clientId: string;
  readonly status: StatusDoCliente;
  readonly secretHash: string;
  readonly previousSecretHash: string | null;
  readonly previousSecretExpiresAt: Date | null;
  readonly escopos: readonly string[];
  readonly grantTypes: readonly TipoDeGrant[];
  readonly accessTokenTtlSegundos: number | null;
  readonly ultimoUsoEm: Date | null;
}

/** O cliente autenticado, como a emissão de token o recebe. */
export interface ClienteAutenticado {
  readonly id: string;
  readonly clientId: string;
  readonly escopos: readonly string[];
  readonly grantTypes: readonly TipoDeGrant[];
  readonly accessTokenTtlSegundos: number | null;
}
