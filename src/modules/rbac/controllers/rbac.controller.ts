/**
 * Responsabilidade: adaptar as rotas do RBAC aos serviços — extrair entrada, chamar o
 * domínio e traduzir `ErroDeRbac` para RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard (`exigirPermissao`/`exigirPapel`) no
 *    preHandler da rota. O controller assume a requisição já autorizada.
 *  - A tradução de erro é explícita (não depende do handler global), para o mesmo contrato
 *    valer num app de teste isolado.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeRbac } from '../errors/rbac.errors.js';
import { papelParaDTO, permissaoParaDTO } from '../dto/rbac.dto.js';
import type { RbacService } from '../services/rbac.service.js';
import type { AssignmentService } from '../services/assignment.service.js';
import type {
  AssociarPermissoesBody,
  AtribuirPapeisBody,
  AtualizarPapelBody,
  CriarPapelBody,
  CriarPermissaoBody,
  IdParams,
  PaginacaoQuery,
  RoleComPermissaoParams,
  UserComPapelParams,
} from '../schemas/rbac.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeRbac {
  readonly rbacService: RbacService;
  readonly assignmentService: AssignmentService;
}

export interface ControllerDeRbac {
  criarPapel(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listarPapeis(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  obterPapel(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  atualizarPapel(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  removerPapel(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  associarPermissoes(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  desassociarPermissao(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  criarPermissao(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listarPermissoes(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  removerPermissao(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listarPapeisDoUsuario(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  atribuirPapeis(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  desatribuirPapel(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

/** Mapeia o código do erro de domínio para status + problem+json. */
function responderErro(erro: ErroDeRbac, resposta: FastifyReply): void {
  const [status, slug, titulo] = ((): [number, string, string] => {
    switch (erro.codigo) {
      case 'papel-nao-encontrado':
        return [404, 'role-not-found', 'Papel não encontrado'];
      case 'permissao-nao-encontrada':
        return [404, 'permission-not-found', 'Permissão não encontrada'];
      case 'usuario-nao-encontrado':
        return [404, 'user-not-found', 'Usuário não encontrado'];
      case 'papel-conflito':
        return [409, 'role-already-exists', 'Papel já existe'];
      case 'permissao-conflito':
        return [409, 'permission-already-exists', 'Permissão já existe'];
      case 'papel-imutavel':
        return [409, 'system-role-immutable', 'Papel de sistema é imutável'];
      case 'permissao-imutavel':
        return [409, 'system-permission-immutable', 'Permissão de sistema é imutável'];
    }
  })();
  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status));
}

/** Executa a ação traduzindo `ErroDeRbac`; qualquer outro erro sobe ao handler global. */
async function comErros(resposta: FastifyReply, acao: () => Promise<void>): Promise<void> {
  try {
    await acao();
  } catch (erro) {
    if (erro instanceof ErroDeRbac) {
      responderErro(erro, resposta);
      return;
    }
    throw erro;
  }
}

export function criarControllerDeRbac(deps: DependenciasDoControllerDeRbac): ControllerDeRbac {
  const { rbacService, assignmentService } = deps;

  return {
    async criarPapel(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { name, description } = req.body as CriarPapelBody;
        const papel = await rbacService.criarPapel({
          name,
          ...(description === undefined ? {} : { description }),
        });
        void resp.status(201).send(papelParaDTO(papel));
      });
    },

    async listarPapeis(req, resp): Promise<void> {
      const { limit, offset } = req.query as PaginacaoQuery;
      const { items, total } = await rbacService.listarPapeis({ limite: limit, offset });
      void resp.status(200).send({ items: items.map(papelParaDTO), total });
    },

    async obterPapel(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const papel = await rbacService.obterPapel(id);
        void resp.status(200).send({ ...papelParaDTO(papel), permissions: papel.permissions });
      });
    },

    async atualizarPapel(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const body = req.body as AtualizarPapelBody;
        const papel = await rbacService.atualizarPapel(id, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
        });
        void resp.status(200).send(papelParaDTO(papel));
      });
    },

    async removerPapel(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        await rbacService.removerPapel(id);
        void resp.status(204).send();
      });
    },

    async associarPermissoes(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const { permission_ids } = req.body as AssociarPermissoesBody;
        await rbacService.associarPermissoes(id, permission_ids);
        void resp.status(204).send();
      });
    },

    async desassociarPermissao(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id, permId } = req.params as RoleComPermissaoParams;
        await rbacService.desassociarPermissao(id, permId);
        void resp.status(204).send();
      });
    },

    async criarPermissao(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { name, description } = req.body as CriarPermissaoBody;
        const permissao = await rbacService.criarPermissao({
          name,
          ...(description === undefined ? {} : { description }),
        });
        void resp.status(201).send(permissaoParaDTO(permissao));
      });
    },

    async listarPermissoes(req, resp): Promise<void> {
      const { limit, offset } = req.query as PaginacaoQuery;
      const { items, total } = await rbacService.listarPermissoes({ limite: limit, offset });
      void resp.status(200).send({ items: items.map(permissaoParaDTO), total });
    },

    async removerPermissao(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        await rbacService.removerPermissao(id);
        void resp.status(204).send();
      });
    },

    async listarPapeisDoUsuario(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const { userId, roles } = await assignmentService.listarPapeisDoUsuario(id);
        void resp.status(200).send({ user_id: userId, roles });
      });
    },

    async atribuirPapeis(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id } = req.params as IdParams;
        const { role_ids } = req.body as AtribuirPapeisBody;
        await assignmentService.atribuirPapeis(id, role_ids);
        void resp.status(204).send();
      });
    },

    async desatribuirPapel(req, resp): Promise<void> {
      await comErros(resp, async () => {
        const { id, roleId } = req.params as UserComPapelParams;
        await assignmentService.desatribuirPapel(id, roleId);
        void resp.status(204).send();
      });
    },
  };
}
