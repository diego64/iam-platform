/**
 * Responsabilidade: administração de clientes de API — criar, listar, alterar, remover e
 * rotacionar segredo.
 * Consumido por: o controller das rotas de clientes.
 * Regras:
 *  - O segredo em claro sai daqui **uma única vez**, no retorno da criação e da rotação.
 *    Não há caminho para recuperá-lo depois: perdeu, rotaciona.
 *  - Escopos são resolvidos antes de qualquer escrita. Um nome inválido derruba a operação
 *    inteira em vez de gravar um cliente com autoridade parcial.
 *  - Não decide autorização: quem separa o que exige superadmin do que exige `clients:write`
 *    é a rota. Aqui só existe a regra de negócio.
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import { ErroDeCliente } from '../errors/api-client.errors.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';
import { gerarClientId, gerarSegredo } from './credential-factory.js';
import type { ResolvedorDeEscopos } from './scope-resolver.js';
import type {
  CamposAtualizaveis,
  FiltroDeClientes,
  RepositorioDeClientes,
} from '../repositories/api-client.repository.js';
import type { ClienteDeApi, StatusDoCliente, TipoDeGrant } from '../types/api-client.types.js';
import { medidorDeClientesNulo, type MedidorDeClientes } from '../metrics/api-clients.metrics.js';

/** Código do PostgreSQL para violação de unicidade. */
const UNIQUE_VIOLATION = '23505';

export interface ConfiguracaoDeClientes {
  readonly repo: RepositorioDeClientes;
  readonly escopos: ResolvedorDeEscopos;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly logger: Logger;
  /** Janela padrão da sobreposição de segredo, usada quando a requisição não informa uma. */
  readonly sobreposicaoPadraoMs: number;
  readonly medidor?: MedidorDeClientes;
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
}

export interface EntradaDeCriacao {
  readonly name: string;
  readonly description?: string | undefined;
  readonly scopes: readonly string[];
  readonly grantTypes: readonly TipoDeGrant[];
  readonly accessTokenTtlSegundos?: number | undefined;
}

export interface EntradaDeAtualizacao {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly status?: Exclude<StatusDoCliente, 'deleted'> | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly grantTypes?: readonly TipoDeGrant[] | undefined;
  readonly accessTokenTtlSegundos?: number | null | undefined;
}

/** O cliente recém-criado, com o segredo em claro que só existe neste retorno. */
export interface ClienteCriado {
  readonly cliente: ClienteDeApi;
  readonly segredo: string;
}

export interface SegredoRotacionado {
  readonly clientId: string;
  readonly segredo: string;
  readonly rotacionadoEm: Date;
  readonly anteriorExpiraEm: Date | null;
}

export interface ApiClientService {
  criar(entrada: EntradaDeCriacao, ator?: string): Promise<ClienteCriado>;
  listar(filtro: FiltroDeClientes): Promise<{ items: ClienteDeApi[]; total: number }>;
  obter(id: string): Promise<ClienteDeApi>;
  atualizar(id: string, entrada: EntradaDeAtualizacao, ator?: string): Promise<ClienteDeApi>;
  remover(id: string, ator?: string): Promise<void>;
  rotacionarSegredo(
    id: string,
    sobreposicaoMs: number | undefined,
    ator?: string,
  ): Promise<SegredoRotacionado>;
  revogarSegredoAnterior(id: string, ator?: string): Promise<void>;
}

/** `true` quando o erro do driver é violação de unicidade — aqui, sempre o nome. */
function ehNomeDuplicado(erro: unknown): boolean {
  return (
    typeof erro === 'object' && erro !== null && 'code' in erro && erro.code === UNIQUE_VIOLATION
  );
}

export function criarApiClientService(config: ConfiguracaoDeClientes): ApiClientService {
  const medidor = config.medidor ?? medidorDeClientesNulo();
  const auditoria = config.auditoria ?? registradorNulo();

  async function exigirCliente(id: string): Promise<ClienteDeApi> {
    const cliente = await config.repo.buscarPorId(id);
    if (cliente === null) {
      throw new ErroDeCliente('cliente-nao-encontrado');
    }
    if (cliente.status === 'deleted') {
      throw new ErroDeCliente('cliente-ja-removido');
    }
    return cliente;
  }

  return {
    async criar(entrada: EntradaDeCriacao, ator?: string): Promise<ClienteCriado> {
      // Resolver antes de gerar credencial: escopo inválido não deve consumir entropia nem
      // deixar rastro de um cliente que não chegou a existir.
      const permissionIds = await config.escopos.resolver(entrada.scopes);

      const segredo = gerarSegredo();
      const secretHash = await config.servicoDeSenha.gerarHash(segredo);

      let cliente: ClienteDeApi;
      try {
        cliente = await config.repo.criar({
          clientId: gerarClientId(),
          secretHash,
          name: entrada.name,
          description: entrada.description,
          grantTypes: entrada.grantTypes,
          accessTokenTtlSegundos: entrada.accessTokenTtlSegundos,
          permissionIds,
        });
      } catch (erro) {
        if (ehNomeDuplicado(erro)) {
          throw new ErroDeCliente('nome-em-uso');
        }
        throw erro;
      }

      medidor.contarCriacao();
      config.logger.info(
        { ator_id: ator ?? null, client_id: cliente.clientId, delta: { escopos: cliente.escopos } },
        'clients.create: cliente criado',
      );
      await auditoria.registrar({
        type: 'iam.client.created',
        actor: { id: ator ?? null, type: 'user' },
        target: { id: cliente.id, type: 'client' },
        outcome: 'success',
        reason: 'admin_action',
        metadata: { client_id: cliente.clientId, escopos: [...cliente.escopos] },
      });

      return { cliente, segredo };
    },

    listar(filtro: FiltroDeClientes): Promise<{ items: ClienteDeApi[]; total: number }> {
      return config.repo.listar(filtro);
    },

    async obter(id: string): Promise<ClienteDeApi> {
      const cliente = await config.repo.buscarPorId(id);
      if (cliente === null) {
        throw new ErroDeCliente('cliente-nao-encontrado');
      }
      return cliente;
    },

    async atualizar(
      id: string,
      entrada: EntradaDeAtualizacao,
      ator?: string,
    ): Promise<ClienteDeApi> {
      await exigirCliente(id);

      const campos: CamposAtualizaveis = {
        name: entrada.name,
        description: entrada.description,
        status: entrada.status,
        grantTypes: entrada.grantTypes,
        accessTokenTtlSegundos: entrada.accessTokenTtlSegundos,
        ...(entrada.scopes === undefined
          ? {}
          : { permissionIds: await config.escopos.resolver(entrada.scopes) }),
      };

      let atualizado: ClienteDeApi | null;
      try {
        atualizado = await config.repo.atualizar(id, campos);
      } catch (erro) {
        if (ehNomeDuplicado(erro)) {
          throw new ErroDeCliente('nome-em-uso');
        }
        throw erro;
      }
      if (atualizado === null) {
        throw new ErroDeCliente('cliente-nao-encontrado');
      }

      medidor.contarAtualizacao();
      config.logger.info(
        { ator_id: ator ?? null, client_id: atualizado.clientId, delta: entrada },
        'clients.update: cliente alterado',
      );
      return atualizado;
    },

    async remover(id: string, ator?: string): Promise<void> {
      const cliente = await exigirCliente(id);

      if (!(await config.repo.removerLogicamente(id))) {
        // A leitura acima passou e o UPDATE não casou: outra requisição removeu no meio.
        throw new ErroDeCliente('cliente-ja-removido');
      }

      medidor.contarRemocao();
      config.logger.info(
        { ator_id: ator ?? null, client_id: cliente.clientId, delta: { status: 'deleted' } },
        'clients.delete: cliente removido',
      );
    },

    async rotacionarSegredo(
      id: string,
      sobreposicaoMs: number | undefined,
      ator?: string,
    ): Promise<SegredoRotacionado> {
      await exigirCliente(id);

      const segredo = gerarSegredo();
      const novoHash = await config.servicoDeSenha.gerarHash(segredo);
      const resultado = await config.repo.rotacionarSegredo(id, {
        novoHash,
        sobreposicaoMs: sobreposicaoMs ?? config.sobreposicaoPadraoMs,
      });
      if (resultado === null) {
        throw new ErroDeCliente('cliente-nao-encontrado');
      }

      medidor.contarRotacaoDeSegredo();
      config.logger.info(
        {
          ator_id: ator ?? null,
          client_id: resultado.clientId,
          delta: { anterior_expira_em: resultado.segredoAnteriorExpiraEm },
        },
        'clients.rotate: segredo rotacionado',
      );
      // O segredo em si nunca entra no evento — só o fato da troca e a janela em que a
      // credencial anterior ainda vale.
      await auditoria.registrar({
        type: 'iam.client.secret_rotated',
        actor: { id: ator ?? null, type: 'user' },
        target: { id, type: 'client' },
        outcome: 'success',
        reason: 'admin_action',
        metadata: {
          anterior_expira_em: resultado.segredoAnteriorExpiraEm?.toISOString() ?? 'imediato',
        },
      });

      return {
        clientId: resultado.clientId,
        segredo,
        rotacionadoEm: resultado.segredoRotacionadoEm,
        anteriorExpiraEm: resultado.segredoAnteriorExpiraEm,
      };
    },

    async revogarSegredoAnterior(id: string, ator?: string): Promise<void> {
      const cliente = await exigirCliente(id);

      if (!(await config.repo.revogarSegredoAnterior(id))) {
        throw new ErroDeCliente('sem-segredo-anterior');
      }

      config.logger.info(
        { ator_id: ator ?? null, client_id: cliente.clientId, delta: { anterior: 'revogado' } },
        'clients.revoke-previous: sobreposição encerrada',
      );
    },
  };
}
