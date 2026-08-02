/**
 * Responsabilidade: adaptar as rotas do ABAC aos serviços — extrair entrada, chamar o
 * domínio e traduzir `ErroDeAbac` para RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard do RBAC (`exigirPermissao`) no preHandler.
 *  - A tradução de erro é explícita (não depende do handler global), para o mesmo contrato
 *    valer num app de teste isolado.
 *  - O simulador (`avaliar`) não carrega recurso do banco: quem chama descreve a situação.
 *    Ele é depuração e PDP online, nunca enforcement — por isso não nega a requisição, só
 *    devolve a decisão.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeAbac, TRADUCAO_DE_ERRO_DE_ABAC } from '../errors/abac.errors.js';
import { decisaoParaDTO, politicaDetalheParaDTO, politicaParaDTO } from '../dto/abac.dto.js';
import type { AbacService } from '../services/abac.service.js';
import type { MotorDePoliticas } from '../services/policy-engine.js';
import type { ContextoDeDecisao, JsonValue } from '../types/abac.types.js';
import type {
  AtualizarPoliticaBody,
  AvaliarBody,
  CriarPoliticaBody,
  IdParams,
  ListarPoliticasQuery,
} from '../schemas/policy.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeAbac {
  readonly abacService: AbacService;
  readonly motor: Pick<MotorDePoliticas, 'avaliar'>;
}

export interface ControllerDeAbac {
  criarPolitica(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listarPoliticas(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  obterPolitica(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  atualizarPolitica(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  removerPolitica(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  avaliar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

function responderErro(erro: ErroDeAbac, resposta: FastifyReply): void {
  const { status, slug, titulo } = TRADUCAO_DE_ERRO_DE_ABAC[erro.codigo];
  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status));
}

/** Executa a ação traduzindo `ErroDeAbac`; qualquer outro erro sobe ao handler global. */
async function comErros(resposta: FastifyReply, acao: () => Promise<void>): Promise<void> {
  try {
    await acao();
  } catch (erro) {
    if (erro instanceof ErroDeAbac) {
      responderErro(erro, resposta);
      return;
    }
    throw erro;
  }
}

export function criarControllerDeAbac(deps: DependenciasDoControllerDeAbac): ControllerDeAbac {
  const { abacService, motor } = deps;

  return {
    async criarPolitica(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const body = req.body as CriarPoliticaBody;
        const politica = await abacService.criarPolitica({
          name: body.name,
          description: body.description ?? null,
          effect: body.effect,
          resourceType: body.resource_type,
          action: body.action,
          condition: body.condition,
          priority: body.priority,
          enabled: body.enabled,
        });
        void resp.status(201).send(politicaParaDTO(politica));
      });
    },

    async listarPoliticas(req, resp): Promise<void> {
      const query = req.query as ListarPoliticasQuery;
      const { items, total } = await abacService.listarPoliticas({
        ...(query.resource_type === undefined ? {} : { resourceType: query.resource_type }),
        ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
        limite: query.limit,
        offset: query.offset,
      });
      void resp.status(200).send({ items: items.map(politicaParaDTO), total });
    },

    async obterPolitica(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const politica = await abacService.obterPolitica(id);
        void resp.status(200).send(politicaDetalheParaDTO(politica));
      });
    },

    async atualizarPolitica(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const body = req.body as AtualizarPoliticaBody;
        const politica = await abacService.atualizarPolitica(id, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.effect === undefined ? {} : { effect: body.effect }),
          ...(body.resource_type === undefined ? {} : { resourceType: body.resource_type }),
          ...(body.action === undefined ? {} : { action: body.action }),
          ...(body.condition === undefined ? {} : { condition: body.condition }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        });
        void resp.status(200).send(politicaParaDTO(politica));
      });
    },

    async removerPolitica(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        await abacService.removerPolitica(id);
        void resp.status(204).send();
      });
    },

    async avaliar(req, resp): Promise<void> {
      const body = req.body as AvaliarBody;
      const contexto: ContextoDeDecisao = {
        subject: { sub: body.subject.sub, roles: body.subject.roles, perm: body.subject.perm },
        resourceType: body.resource_type,
        resource: body.resource as Record<string, JsonValue>,
        action: body.action,
        env: {
          ...(body.env?.ip === undefined ? {} : { ip: body.env.ip }),
          now: body.env?.now === undefined ? new Date() : new Date(body.env.now),
        },
      };
      const decisao = await motor.avaliar(contexto);
      void resp.status(200).send(decisaoParaDTO(decisao));
    },
  };
}
