/**
 * Responsabilidade: adaptar as rotas de clientes ao serviço — extrair entrada, chamar o
 * domínio e traduzir `ErroDeCliente` para RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard no preHandler da rota. O controller assume
 *    a requisição já autorizada.
 *  - A tradução de erro é explícita (não depende do handler global), para o mesmo contrato
 *    valer num app de teste isolado.
 *  - O segredo em claro sai em exatamente duas respostas: a criação e a rotação.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { idAutenticado } from '../../auth/middleware/verify-access-token.js';
import { ErroDeCliente } from '../errors/api-client.errors.js';
import { clienteParaDTO } from '../dto/api-client.dto.js';
import type { ApiClientService } from '../services/api-client.service.js';
import type {
  AtualizarClienteBody,
  CriarClienteBody,
  IdParams,
  ListarClientesQuery,
  RotacionarSegredoBody,
} from '../schemas/api-client.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeClientes {
  readonly service: ApiClientService;
  /** Convertido para milissegundos antes de chegar ao serviço. */
  readonly sobreposicaoPadraoMs: number;
}

export interface ControllerDeClientes {
  criar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  obter(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  atualizar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  remover(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  rotacionarSegredo(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  revogarSegredoAnterior(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

/** Mapeia o código do erro de domínio para status + problem+json. */
function responderErro(erro: ErroDeCliente, resposta: FastifyReply): void {
  const [status, slug, titulo, detalhe] = ((): [number, string, string, string | undefined] => {
    switch (erro.codigo) {
      case 'cliente-nao-encontrado':
        return [404, 'client-not-found', 'Cliente não encontrado', undefined];
      case 'cliente-ja-removido':
        return [409, 'client-already-deleted', 'Cliente já removido', undefined];
      case 'nome-em-uso':
        return [409, 'client-name-already-exists', 'Nome de cliente já existe', undefined];
      case 'curinga-proibido':
        return [
          409,
          'wildcard-scope-forbidden',
          'Escopo curinga não é concedível',
          'O curinga daria ao cliente qualquer autoridade do sistema',
        ];
      case 'sem-segredo-anterior':
        return [409, 'no-previous-secret', 'Nenhuma sobreposição em andamento', undefined];
      case 'escopo-desconhecido':
        return [
          422,
          'unknown-scope',
          'Escopo desconhecido',
          // Os nomes pedidos não são sensíveis: são permissões do catálogo, que a rota de
          // permissões já lista. Sem eles, o operador descobre por eliminação.
          `Não existem no catálogo: ${erro.escoposDesconhecidos.join(', ')}`,
        ];
    }
  })();

  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status, detalhe));
}

/** Executa a ação traduzindo o erro de domínio; o resto sobe para o handler global. */
async function comTraducao(resp: FastifyReply, acao: () => Promise<void>): Promise<void> {
  try {
    await acao();
  } catch (erro) {
    if (erro instanceof ErroDeCliente) {
      responderErro(erro, resp);
      return;
    }
    throw erro;
  }
}

export function criarControllerDeClientes(
  deps: DependenciasDoControllerDeClientes,
): ControllerDeClientes {
  return {
    async criar(req, resp): Promise<void> {
      const corpo = req.body as CriarClienteBody;
      await comTraducao(resp, async () => {
        const { cliente, segredo } = await deps.service.criar(
          {
            name: corpo.name,
            description: corpo.description,
            scopes: corpo.scopes,
            grantTypes: corpo.grant_types,
            accessTokenTtlSegundos: corpo.access_token_ttl_seconds,
          },
          idAutenticado(req) ?? undefined,
        );
        await resp.status(201).send({ ...clienteParaDTO(cliente), client_secret: segredo });
      });
    },

    async listar(req, resp): Promise<void> {
      const query = req.query as ListarClientesQuery;
      const { items, total } = await deps.service.listar({
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
      await resp.send({ items: items.map(clienteParaDTO), total });
    },

    async obter(req, resp): Promise<void> {
      const { id } = req.params as IdParams;
      await comTraducao(resp, async () => {
        await resp.send(clienteParaDTO(await deps.service.obter(id)));
      });
    },

    async atualizar(req, resp): Promise<void> {
      const { id } = req.params as IdParams;
      const corpo = req.body as AtualizarClienteBody;
      await comTraducao(resp, async () => {
        const atualizado = await deps.service.atualizar(
          id,
          {
            name: corpo.name,
            description: corpo.description,
            status: corpo.status,
            scopes: corpo.scopes,
            grantTypes: corpo.grant_types,
            accessTokenTtlSegundos: corpo.access_token_ttl_seconds,
          },
          idAutenticado(req) ?? undefined,
        );
        await resp.send(clienteParaDTO(atualizado));
      });
    },

    async remover(req, resp): Promise<void> {
      const { id } = req.params as IdParams;
      await comTraducao(resp, async () => {
        await deps.service.remover(id, idAutenticado(req) ?? undefined);
        await resp.status(204).send();
      });
    },

    async rotacionarSegredo(req, resp): Promise<void> {
      const { id } = req.params as IdParams;
      const corpo = req.body as RotacionarSegredoBody;
      await comTraducao(resp, async () => {
        const rotacionado = await deps.service.rotacionarSegredo(
          id,
          corpo.overlap_seconds === undefined ? undefined : corpo.overlap_seconds * 1000,
          idAutenticado(req) ?? undefined,
        );
        await resp.send({
          client_id: rotacionado.clientId,
          client_secret: rotacionado.segredo,
          secret_rotated_at: rotacionado.rotacionadoEm.toISOString(),
          previous_secret_expires_at: rotacionado.anteriorExpiraEm?.toISOString() ?? null,
        });
      });
    },

    async revogarSegredoAnterior(req, resp): Promise<void> {
      const { id } = req.params as IdParams;
      await comTraducao(resp, async () => {
        await deps.service.revogarSegredoAnterior(id, idAutenticado(req) ?? undefined);
        await resp.status(204).send();
      });
    },
  };
}
