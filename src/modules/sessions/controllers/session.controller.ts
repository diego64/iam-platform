/**
 * Responsabilidade: adaptar as rotas de sessão ao serviço — resolver o usuário do token,
 * chamar o domínio e traduzir a ausência de sessão para RFC 7807.
 * Regras:
 *  - Tradução de erro explícita aqui, para o mesmo contrato valer num app de teste isolado.
 *  - Sessão inexistente ou de outro dono ⇒ mesmo 404 (sem enumeração).
 *  - "Encerrar as demais" usa a `sid` do token corrente como a sessão a preservar.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeSessaoNaoEncontrada } from '../errors/session-error.js';
import type { SessionService } from '../services/session.service.js';
import type { ParamsSessao } from '../schemas/session.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeSessao {
  readonly sessionService: SessionService;
}

export interface ControllerDeSessao {
  listar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  revogar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  revogarOutras(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

function recusarSemToken(resposta: FastifyReply): void {
  void resposta
    .status(401)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema('invalid-token', 'Token inválido', 401));
}

export function criarControllerDeSessao(
  deps: DependenciasDoControllerDeSessao,
): ControllerDeSessao {
  return {
    async listar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const usuario = requisicao.usuario;
      if (usuario === undefined) {
        recusarSemToken(resposta);
        return;
      }
      const sessions = await deps.sessionService.listar(usuario.id, usuario.sid);
      await resposta.status(200).send({ sessions });
    },

    async revogar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const usuario = requisicao.usuario;
      if (usuario === undefined) {
        recusarSemToken(resposta);
        return;
      }
      const { id } = requisicao.params as ParamsSessao;
      try {
        await deps.sessionService.revogar(id, usuario.id);
        await resposta.status(204).send();
      } catch (erro) {
        if (erro instanceof ErroDeSessaoNaoEncontrada) {
          await resposta
            .status(404)
            .type(TIPO_PROBLEM_JSON)
            .send(montarProblema('session-not-found', 'Sessão não encontrada', 404));
          return;
        }
        throw erro;
      }
    },

    async revogarOutras(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const usuario = requisicao.usuario;
      if (usuario === undefined) {
        recusarSemToken(resposta);
        return;
      }
      const revogadas = await deps.sessionService.revogarOutras(usuario.id, usuario.sid);
      await resposta.status(200).send({ revogadas });
    },
  };
}
