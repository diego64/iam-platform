/**
 * Responsabilidade: adaptar as rotas de leitura ao repositório.
 * Regras:
 *  - Só leitura. Não existe caminho de escrita: aceitar evento de fora transformaria o
 *    detector num alvo — bastaria inundar a coleção de eventos falsos para esconder o
 *    ataque de verdade.
 *  - O DTO devolve a pista, nunca o identificador. Quem investiga cruza com a trilha, e esse
 *    cruzamento fica auditado.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import type { RepositorioDeEventosDeSeguranca } from '../repositories/security-event.repository.js';
import type { EventoDeSeguranca } from '../types/security-event.js';
import type { ConsultaDeEventos } from '../schemas/security.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
/** Sem recorte explícito, a leitura assume o último dia. */
const JANELA_PADRAO_MS = 24 * 60 * 60 * 1000;

export interface DependenciasDoControllerDeSeguranca {
  readonly eventos: RepositorioDeEventosDeSeguranca;
}

export interface ControllerDeSeguranca {
  listar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  obter(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

function paraDto(evento: EventoDeSeguranca): Record<string, unknown> {
  return {
    id: evento.id,
    regra: evento.regra,
    severidade: evento.severidade,
    sujeito: evento.sujeito,
    ocorrencias: evento.ocorrencias,
    janela_ms: evento.janelaMs,
    primeira_em: evento.primeiraEm.toISOString(),
    ultima_em: evento.ultimaEm.toISOString(),
    detectado_em: evento.detectadoEm.toISOString(),
    trace_id: evento.traceId,
    metadata: evento.metadata,
  };
}

export function criarControllerDeSeguranca(
  deps: DependenciasDoControllerDeSeguranca,
): ControllerDeSeguranca {
  return {
    async listar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const consulta = requisicao.query as ConsultaDeEventos;
      const ate = consulta.ate ?? new Date();
      const desde = consulta.desde ?? new Date(ate.getTime() - JANELA_PADRAO_MS);

      const pagina = await deps.eventos.listar({
        desde,
        ate,
        limite: consulta.limite,
        ...(consulta.regra === undefined ? {} : { regra: consulta.regra }),
        ...(consulta.severidade === undefined ? {} : { severidade: consulta.severidade }),
        ...(consulta.pista === undefined ? {} : { pista: consulta.pista }),
        ...(consulta.cursor === undefined ? {} : { cursor: consulta.cursor }),
      });

      await resposta.status(200).send({
        items: pagina.itens.map(paraDto),
        proximo_cursor: pagina.proximoCursor,
      });
    },

    async obter(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const { id } = requisicao.params as { id: string };
      const evento = await deps.eventos.buscarPorId(id);

      if (evento === null) {
        await resposta
          .status(404)
          .type(TIPO_PROBLEM_JSON)
          .send(montarProblema('security-event-not-found', 'Evento não encontrado', 404));
        return;
      }

      await resposta.status(200).send(paraDto(evento));
    },
  };
}
