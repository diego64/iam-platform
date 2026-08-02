/**
 * Responsabilidade: acesso às tabelas `api_clients` e `api_client_scopes` em PostgreSQL.
 * Consumido por: o serviço de clientes (administração) e o de autenticação de cliente.
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão.
 *  - SQL sempre parametrizado; colunas nominais (nada de `SELECT *`).
 *  - Criação e troca de escopos rodam numa transação: um cliente com metade dos escopos
 *    aplicados é pior que nenhum cliente, porque parece configurado e autoriza menos do que
 *    deveria — falha silenciosa em produção.
 *  - `buscarPorClientId` nunca enxerga cliente removido: o soft delete precisa negar a
 *    autenticação tão firmemente quanto o hard delete negaria.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ClienteDeApi,
  CredenciaisDoCliente,
  StatusDoCliente,
  TipoDeGrant,
} from '../types/api-client.types.js';

const COLUNAS_PUBLICAS = `c.id, c.client_id, c.name, c.description, c.status, c.grant_types,
  c.access_token_ttl_seconds, c.created_at, c.updated_at, c.last_used_at,
  c.secret_rotated_at, c.previous_secret_expires_at`;

/** Agrega os escopos numa coluna só, evitando uma segunda ida ao banco por cliente. */
const ESCOPOS_AGREGADOS = `COALESCE(
    (SELECT array_agg(p.name ORDER BY p.name)
       FROM api_client_scopes s JOIN permissions p ON p.id = s.permission_id
      WHERE s.client_id = c.id),
    '{}'
  ) AS escopos`;

interface LinhaPublica {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: StatusDoCliente;
  readonly grant_types: TipoDeGrant[];
  readonly access_token_ttl_seconds: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_used_at: Date | null;
  readonly secret_rotated_at: Date | null;
  readonly previous_secret_expires_at: Date | null;
  readonly escopos: string[];
}

interface LinhaDeCredenciais {
  readonly id: string;
  readonly client_id: string;
  readonly status: StatusDoCliente;
  readonly secret_hash: string;
  readonly previous_secret_hash: string | null;
  readonly previous_secret_expires_at: Date | null;
  readonly grant_types: TipoDeGrant[];
  readonly access_token_ttl_seconds: number | null;
  readonly last_used_at: Date | null;
  readonly escopos: string[];
}

function paraEntidade(linha: LinhaPublica): ClienteDeApi {
  return {
    id: linha.id,
    clientId: linha.client_id,
    name: linha.name,
    description: linha.description,
    status: linha.status,
    escopos: linha.escopos,
    grantTypes: linha.grant_types,
    accessTokenTtlSegundos: linha.access_token_ttl_seconds,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    ultimoUsoEm: linha.last_used_at,
    segredoRotacionadoEm: linha.secret_rotated_at,
    segredoAnteriorExpiraEm: linha.previous_secret_expires_at,
  };
}

function paraCredenciais(linha: LinhaDeCredenciais): CredenciaisDoCliente {
  return {
    id: linha.id,
    clientId: linha.client_id,
    status: linha.status,
    secretHash: linha.secret_hash,
    previousSecretHash: linha.previous_secret_hash,
    previousSecretExpiresAt: linha.previous_secret_expires_at,
    escopos: linha.escopos,
    grantTypes: linha.grant_types,
    accessTokenTtlSegundos: linha.access_token_ttl_seconds,
    ultimoUsoEm: linha.last_used_at,
  };
}

export interface EntradaDeCliente {
  readonly clientId: string;
  readonly secretHash: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly grantTypes: readonly TipoDeGrant[];
  readonly accessTokenTtlSegundos?: number | undefined;
  /** Ids das permissões que viram escopo. Já resolvidos e validados pelo serviço. */
  readonly permissionIds: readonly string[];
}

export interface CamposAtualizaveis {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly status?: Exclude<StatusDoCliente, 'deleted'> | undefined;
  readonly grantTypes?: readonly TipoDeGrant[] | undefined;
  readonly accessTokenTtlSegundos?: number | null | undefined;
  /** Presente, substitui o conjunto inteiro de escopos. Ausente, não toca neles. */
  readonly permissionIds?: readonly string[] | undefined;
}

export interface FiltroDeClientes {
  readonly status?: StatusDoCliente | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface RotacaoDeSegredo {
  readonly novoHash: string;
  /** Zero encerra o segredo anterior no ato. */
  readonly sobreposicaoMs: number;
}

export interface ResultadoDaRotacaoDeSegredo {
  readonly clientId: string;
  readonly segredoRotacionadoEm: Date;
  readonly segredoAnteriorExpiraEm: Date | null;
}

export interface RepositorioDeClientes {
  criar(entrada: EntradaDeCliente): Promise<ClienteDeApi>;
  buscarPorId(id: string): Promise<ClienteDeApi | null>;
  /** Credenciais para autenticar. Cliente removido não é encontrado. */
  buscarPorClientId(clientId: string): Promise<CredenciaisDoCliente | null>;
  listar(filtro: FiltroDeClientes): Promise<{ items: ClienteDeApi[]; total: number }>;
  atualizar(id: string, campos: CamposAtualizaveis): Promise<ClienteDeApi | null>;
  /** Soft delete. `false` quando o cliente não existe ou já estava removido. */
  removerLogicamente(id: string): Promise<boolean>;
  rotacionarSegredo(
    id: string,
    rotacao: RotacaoDeSegredo,
  ): Promise<ResultadoDaRotacaoDeSegredo | null>;
  /** `false` quando não havia sobreposição em andamento. */
  revogarSegredoAnterior(id: string): Promise<boolean>;
  /** Regrava o último uso só se o valor corrente for mais velho que o throttle. */
  registrarUso(id: string, throttleMs: number): Promise<void>;
}

export function criarRepositorioDeClientes(pool: Pool): RepositorioDeClientes {
  /** Lê o cliente já com os escopos agregados. Reusa a conexão da transação quando há uma. */
  async function lerPorId(id: string, cliente: Pool | PoolClient): Promise<ClienteDeApi | null> {
    const { rows } = await cliente.query<LinhaPublica>(
      `SELECT ${COLUNAS_PUBLICAS}, ${ESCOPOS_AGREGADOS} FROM api_clients c WHERE c.id = $1`,
      [id],
    );
    const linha = rows[0];
    return linha === undefined ? null : paraEntidade(linha);
  }

  /** Substitui o conjunto de escopos por completo, dentro da transação recebida. */
  async function trocarEscopos(
    conexao: PoolClient,
    id: string,
    permissionIds: readonly string[],
  ): Promise<void> {
    await conexao.query('DELETE FROM api_client_scopes WHERE client_id = $1', [id]);
    if (permissionIds.length > 0) {
      await conexao.query(
        `INSERT INTO api_client_scopes (client_id, permission_id)
         SELECT $1, unnest($2::uuid[])`,
        [id, permissionIds],
      );
    }
  }

  return {
    async criar(entrada: EntradaDeCliente): Promise<ClienteDeApi> {
      const conexao = await pool.connect();
      try {
        await conexao.query('BEGIN');
        const { rows } = await conexao.query<{ id: string }>(
          `INSERT INTO api_clients
             (client_id, secret_hash, name, description, grant_types, access_token_ttl_seconds)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            entrada.clientId,
            entrada.secretHash,
            entrada.name,
            entrada.description ?? null,
            entrada.grantTypes,
            entrada.accessTokenTtlSegundos ?? null,
          ],
        );
        const id = rows[0]?.id ?? '';
        await trocarEscopos(conexao, id, entrada.permissionIds);
        await conexao.query('COMMIT');

        // O INSERT acabou de acontecer nesta transação; a leitura sempre encontra.
        return (await lerPorId(id, pool)) as ClienteDeApi;
      } catch (erro) {
        await conexao.query('ROLLBACK');
        throw erro;
      } finally {
        conexao.release();
      }
    },

    buscarPorId(id: string): Promise<ClienteDeApi | null> {
      return lerPorId(id, pool);
    },

    async buscarPorClientId(clientId: string): Promise<CredenciaisDoCliente | null> {
      const { rows } = await pool.query<LinhaDeCredenciais>(
        `SELECT c.id, c.client_id, c.status, c.secret_hash, c.previous_secret_hash,
                c.previous_secret_expires_at, c.grant_types, c.access_token_ttl_seconds,
                c.last_used_at, ${ESCOPOS_AGREGADOS}
           FROM api_clients c
          WHERE c.client_id = $1 AND c.status <> 'deleted'`,
        [clientId],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraCredenciais(linha);
    },

    async listar(filtro: FiltroDeClientes): Promise<{ items: ClienteDeApi[]; total: number }> {
      // Sem status pedido, remove os apagados: eles existem para preservar o histórico, não
      // para aparecer numa listagem de administração.
      const { rows } = await pool.query<LinhaPublica & { total: string }>(
        `SELECT ${COLUNAS_PUBLICAS}, ${ESCOPOS_AGREGADOS}, count(*) OVER () ::text AS total
           FROM api_clients c
          WHERE CASE WHEN $1::text IS NULL THEN c.status <> 'deleted' ELSE c.status = $1::text END
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3`,
        [filtro.status ?? null, filtro.limit, filtro.offset],
      );
      return {
        items: rows.map(paraEntidade),
        total: Number(rows[0]?.total ?? 0),
      };
    },

    async atualizar(id: string, campos: CamposAtualizaveis): Promise<ClienteDeApi | null> {
      const conexao = await pool.connect();
      try {
        await conexao.query('BEGIN');

        // COALESCE deixa cada campo ausente manter o valor corrente numa instrução só. O TTL
        // usa um sentinela negativo porque nele o NULL é um valor legítimo — significa
        // "usar o TTL global" — e COALESCE não distingue isso de "não mexer".
        const { rowCount } = await conexao.query(
          `UPDATE api_clients
              SET name = COALESCE($2, name),
                  description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                  status = COALESCE($5, status),
                  grant_types = COALESCE($6, grant_types),
                  access_token_ttl_seconds =
                    CASE WHEN $7::int IS NULL THEN access_token_ttl_seconds
                         WHEN $7::int < 0 THEN NULL
                         ELSE $7::int END,
                  updated_at = now()
            WHERE id = $1 AND status <> 'deleted'`,
          [
            id,
            campos.name ?? null,
            campos.description !== undefined,
            campos.description ?? null,
            campos.status ?? null,
            campos.grantTypes ?? null,
            campos.accessTokenTtlSegundos === undefined
              ? null
              : (campos.accessTokenTtlSegundos ?? -1),
          ],
        );

        if (rowCount === 0) {
          await conexao.query('ROLLBACK');
          return null;
        }

        if (campos.permissionIds !== undefined) {
          await trocarEscopos(conexao, id, campos.permissionIds);
        }
        await conexao.query('COMMIT');
        return await lerPorId(id, pool);
      } catch (erro) {
        await conexao.query('ROLLBACK');
        throw erro;
      } finally {
        conexao.release();
      }
    },

    async removerLogicamente(id: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE api_clients
            SET status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE id = $1 AND status <> 'deleted'`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    },

    async rotacionarSegredo(
      id: string,
      rotacao: RotacaoDeSegredo,
    ): Promise<ResultadoDaRotacaoDeSegredo | null> {
      // O hash corrente vira o anterior — nunca acumula uma terceira via, porque a coluna é
      // uma só. Sobreposição zero apaga o anterior no mesmo UPDATE, mantendo o CHECK de
      // coerência satisfeito (os dois campos nulos juntos).
      const { rows } = await pool.query<{
        client_id: string;
        secret_rotated_at: Date;
        previous_secret_expires_at: Date | null;
      }>(
        `UPDATE api_clients
            SET previous_secret_hash =
                  CASE WHEN $3::bigint > 0 THEN secret_hash ELSE NULL END,
                previous_secret_expires_at =
                  CASE WHEN $3::bigint > 0
                       THEN now() + ($3::bigint * interval '1 millisecond')
                       ELSE NULL END,
                secret_hash = $2,
                secret_rotated_at = now(),
                updated_at = now()
          WHERE id = $1 AND status <> 'deleted'
          RETURNING client_id, secret_rotated_at, previous_secret_expires_at`,
        [id, rotacao.novoHash, rotacao.sobreposicaoMs],
      );
      const linha = rows[0];
      return linha === undefined
        ? null
        : {
            clientId: linha.client_id,
            segredoRotacionadoEm: linha.secret_rotated_at,
            segredoAnteriorExpiraEm: linha.previous_secret_expires_at,
          };
    },

    async revogarSegredoAnterior(id: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE api_clients
            SET previous_secret_hash = NULL, previous_secret_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'deleted' AND previous_secret_hash IS NOT NULL`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    },

    async registrarUso(id: string, throttleMs: number): Promise<void> {
      // O throttle está na cláusula WHERE, não no serviço: assim duas réplicas autenticando
      // o mesmo cliente ao mesmo tempo não geram duas escritas — a segunda não casa.
      await pool.query(
        `UPDATE api_clients SET last_used_at = now()
          WHERE id = $1
            AND (last_used_at IS NULL
                 OR last_used_at < now() - ($2::bigint * interval '1 millisecond'))`,
        [id, throttleMs],
      );
    },
  };
}
