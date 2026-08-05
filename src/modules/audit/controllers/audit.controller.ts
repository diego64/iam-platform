/**
 * Responsabilidade: adaptar as rotas de auditoria aos serviços — extrair filtro, chamar o
 * domínio e traduzir `ErroDeAuditoria` para RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard no preHandler da rota.
 *  - Trilha adulterada responde **200**, não erro: a verificação executou com sucesso e o
 *    achado é o resultado. Erro de infraestrutura durante a varredura é que vira 503.
 *  - A tradução de erro é explícita, para o mesmo contrato valer num app de teste isolado.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeAuditoria } from '../errors/audit.errors.js';
import { eventoParaDTO, eventoParaDetalheDTO } from '../dto/audit.dto.js';
import type { AuditQueryService } from '../services/audit-query.service.js';
import type { AuditIntegrityService } from '../services/audit-integrity.service.js';
import type { FiltroDaTrilha } from '../repositories/audit-log.repository.js';
import type {
  EventoParams,
  IntegridadeQuery,
  ListarEventosQuery,
} from '../schemas/audit.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeAuditoria {
  readonly consulta: AuditQueryService;
  readonly integridade: AuditIntegrityService;
}

export interface ControllerDeAuditoria {
  listar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  obter(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  verificar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  recusarEscrita(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

function responderErro(erro: ErroDeAuditoria, resposta: FastifyReply): void {
  const [status, slug, titulo] = ((): [number, string, string] => {
    switch (erro.codigo) {
      case 'evento-nao-encontrado':
        return [404, 'event-not-found', 'Evento não encontrado'];
      case 'janela-grande-demais':
        return [400, 'validation-error', 'Requisição inválida'];
      case 'trilha-indisponivel':
        return [503, 'audit-unavailable', 'Trilha indisponível'];
      case 'metadata-proibida':
        // Não alcança a borda: é recusa de escrita, e escrita não tem rota. Mapeado para
        // não deixar o `switch` incompleto quando o vocabulário de erro crescer.
        return [400, 'validation-error', 'Requisição inválida'];
    }
  })();
  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status));
}

async function comErros(resposta: FastifyReply, acao: () => Promise<void>): Promise<void> {
  try {
    await acao();
  } catch (erro) {
    if (erro instanceof ErroDeAuditoria) {
      responderErro(erro, resposta);
      return;
    }
    throw erro;
  }
}

/** Traduz o filtro da querystring para o do repositório, omitindo o que não veio. */
function paraFiltro(query: ListarEventosQuery): FiltroDaTrilha {
  return {
    limite: query.limite,
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(query.actor_id === undefined ? {} : { actorId: query.actor_id }),
    ...(query.target_id === undefined ? {} : { targetId: query.target_id }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(query.de === undefined ? {} : { de: query.de }),
    ...(query.ate === undefined ? {} : { ate: query.ate }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

export function criarControllerDeAuditoria(
  deps: DependenciasDoControllerDeAuditoria,
): ControllerDeAuditoria {
  return {
    async listar(requisicao, resposta): Promise<void> {
      await comErros(resposta, async () => {
        const pagina = await deps.consulta.listar(
          paraFiltro(requisicao.query as ListarEventosQuery),
        );
        await resposta.status(200).send({
          itens: pagina.itens.map(eventoParaDTO),
          proximo_cursor: pagina.proximoCursor,
          tem_mais: pagina.temMais,
        });
      });
    },

    async obter(requisicao, resposta): Promise<void> {
      await comErros(resposta, async () => {
        const { seq } = requisicao.params as EventoParams;
        const evento = await deps.consulta.obterPorSeq(seq);
        await resposta.status(200).send(eventoParaDetalheDTO(evento));
      });
    },

    async verificar(requisicao, resposta): Promise<void> {
      await comErros(resposta, async () => {
        const { de, ate } = requisicao.query as IntegridadeQuery;
        const relatorio = await deps.integridade.verificar({
          de,
          ...(ate === undefined ? {} : { ate }),
        });
        await resposta.status(200).send({
          integra: relatorio.integra,
          de: relatorio.de,
          ate: relatorio.ate,
          verificados: relatorio.verificados,
          primeira_quebra: relatorio.primeiraQuebra,
          checkpoint_conferido: relatorio.checkpointConferido,
        });
      });
    },

    async recusarEscrita(_requisicao, resposta): Promise<void> {
      // A rota existe só para a recusa ser parte do contrato: a trilha é escrita de dentro
      // do processo, e um 404 aqui deixaria a ausência parecendo esquecimento.
      await resposta
        .status(405)
        .type(TIPO_PROBLEM_JSON)
        .send(
          montarProblema(
            'method-not-allowed',
            'Método não permitido',
            405,
            'A trilha de auditoria não aceita escrita externa.',
          ),
        );
    },
  };
}
