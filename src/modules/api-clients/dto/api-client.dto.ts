/**
 * DTO de saída do cliente de API: mapeia a entidade (camelCase, `Date`) para o corpo
 * snake_case com timestamps ISO.
 *
 * A conversão é campo a campo de propósito. Espalhar a entidade faria uma coluna nova vazar
 * sozinha no dia em que a tabela crescer — e nesta tabela as colunas novas prováveis são
 * justamente hashes de segredo.
 */
import type { ClienteDeApi, StatusDoCliente, TipoDeGrant } from '../types/api-client.types.js';

export interface ClienteDTO {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: StatusDoCliente;
  readonly scopes: readonly string[];
  readonly grant_types: readonly TipoDeGrant[];
  readonly access_token_ttl_seconds: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_used_at: string | null;
  readonly secret_rotated_at: string | null;
  readonly previous_secret_expires_at: string | null;
}

function iso(data: Date | null): string | null {
  return data === null ? null : data.toISOString();
}

export function clienteParaDTO(cliente: ClienteDeApi): ClienteDTO {
  return {
    id: cliente.id,
    client_id: cliente.clientId,
    name: cliente.name,
    description: cliente.description,
    status: cliente.status,
    scopes: cliente.escopos,
    grant_types: cliente.grantTypes,
    access_token_ttl_seconds: cliente.accessTokenTtlSegundos,
    created_at: cliente.criadoEm.toISOString(),
    updated_at: cliente.atualizadoEm.toISOString(),
    last_used_at: iso(cliente.ultimoUsoEm),
    secret_rotated_at: iso(cliente.segredoRotacionadoEm),
    previous_secret_expires_at: iso(cliente.segredoAnteriorExpiraEm),
  };
}
