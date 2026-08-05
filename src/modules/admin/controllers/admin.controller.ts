/**
 * Responsabilidade: adaptar as rotas do painel aos serviços e traduzir `ErroDeAdmin` para
 * RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard no preHandler da rota, e a barreira de boot
 *    garante que ele existe.
 *  - O ator sai de `request.usuario`, posto pela verificação do token. Sem ele a requisição
 *    nem chegaria aqui; o `??` existe só para o tipo, e cai em string vazia — que nunca
 *    coincide com um id real e, portanto, nunca libera a recusa de sessão própria.
 *  - A tradução de erro é explícita, para o mesmo contrato valer num app de teste isolado.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeAdmin } from '../errors/admin.errors.js';
import { fichaParaDTO, sessaoParaDTO, visaoGeralParaDTO } from '../dto/admin.dto.js';
import type { OverviewService } from '../services/overview.service.js';
import type { UserViewService } from '../services/user-view.service.js';
import type { AdminSessionsService } from '../services/admin-sessions.service.js';
import { medidorDeAdminNulo, type MedidorDeAdmin } from '../metrics/admin.metrics.js';
import type { SessaoParams, UsuarioParams } from '../schemas/admin.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeAdmin {
  readonly overview: OverviewService;
  readonly ficha: UserViewService;
  readonly sessoes: AdminSessionsService;
  readonly medidor?: MedidorDeAdmin;
}

export interface ControllerDeAdmin {
  visaoGeral(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  fichaDeUsuario(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  listarSessoes(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  revogarSessao(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  revogarSessoes(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

function responderErro(erro: ErroDeAdmin, resposta: FastifyReply): number {
  const [status, slug, titulo, detalhe] = ((): [number, string, string, string | undefined] => {
    switch (erro.codigo) {
      case 'usuario-nao-encontrado':
        return [404, 'user-not-found', 'Usuário não encontrado', undefined];
      case 'sessao-nao-encontrada':
        return [404, 'session-not-found', 'Sessão não encontrada', undefined];
      case 'sessao-propria':
        return [
          409,
          'use-own-session-endpoint',
          'Sessão própria',
          'Revogue as próprias sessões pelas rotas de sessão do usuário autenticado.',
        ];
      case 'fonte-essencial-indisponivel':
        return [503, 'admin-source-unavailable', 'Fonte indisponível', undefined];
    }
  })();
  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status, detalhe));
  return status;
}

export function criarControllerDeAdmin(deps: DependenciasDoControllerDeAdmin): ControllerDeAdmin {
  const medidor = deps.medidor ?? medidorDeAdminNulo();

  /** Executa a ação medindo a rota e traduzindo o erro de domínio. */
  async function tratar(
    rota: string,
    resposta: FastifyReply,
    acao: () => Promise<number>,
  ): Promise<void> {
    try {
      medidor.contarRequisicao(rota, await acao());
    } catch (erro) {
      if (erro instanceof ErroDeAdmin) {
        medidor.contarRequisicao(rota, responderErro(erro, resposta));
        return;
      }
      throw erro;
    }
  }

  function ator(requisicao: FastifyRequest): string {
    return requisicao.usuario?.id ?? '';
  }

  return {
    async visaoGeral(_requisicao, resposta): Promise<void> {
      await tratar('/admin/overview', resposta, async () => {
        const inicio = process.hrtime.bigint();
        const { visao, doCache } = await deps.overview.obter();
        if (!doCache) {
          medidor.observarAgregacao('overview', Number(process.hrtime.bigint() - inicio) / 1e9);
        }
        await resposta.status(200).send(visaoGeralParaDTO(visao, doCache));
        return 200;
      });
    },

    async fichaDeUsuario(requisicao, resposta): Promise<void> {
      await tratar('/admin/users/:id', resposta, async () => {
        const inicio = process.hrtime.bigint();
        const { id } = requisicao.params as UsuarioParams;
        const ficha = await deps.ficha.obter(id);
        medidor.observarAgregacao('usuario', Number(process.hrtime.bigint() - inicio) / 1e9);
        await resposta.status(200).send(fichaParaDTO(ficha));
        return 200;
      });
    },

    async listarSessoes(requisicao, resposta): Promise<void> {
      await tratar('/admin/users/:id/sessions', resposta, async () => {
        const { id } = requisicao.params as UsuarioParams;
        const sessoes = await deps.sessoes.listar(id);
        await resposta
          .status(200)
          .send({ itens: sessoes.map(sessaoParaDTO), total: sessoes.length });
        return 200;
      });
    },

    async revogarSessao(requisicao, resposta): Promise<void> {
      await tratar('/admin/users/:id/sessions/:sessionId', resposta, async () => {
        const { id, sessionId } = requisicao.params as SessaoParams;
        await deps.sessoes.revogarUma(ator(requisicao), id, sessionId);
        await resposta.status(204).send();
        return 204;
      });
    },

    async revogarSessoes(requisicao, resposta): Promise<void> {
      await tratar('/admin/users/:id/sessions', resposta, async () => {
        const { id } = requisicao.params as UsuarioParams;
        const revogadas = await deps.sessoes.revogarTodas(ator(requisicao), id);
        await resposta.status(200).send({ revogadas });
        return 200;
      });
    },
  };
}
