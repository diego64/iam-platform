/**
 * Responsabilidade: adaptar a rota de teste ao serviço de notificação.
 * Regras:
 *  - **O destinatário é a configuração, nunca a requisição.** É o que separa uma rota de
 *    diagnóstico de um relay de spam autenticado.
 *  - Falha de entrega responde 200 relatando o desfecho: o erro é do provedor, não da
 *    requisição. Um 502 aqui diria que o pedido estava errado, e ele não estava.
 *  - Sem endereço de operação configurado, 409: não há o que testar, e responder "ok"
 *    esconderia justamente a configuração faltando que a rota existe para revelar.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import type { ServicoDeNotificacao } from '../services/notification.service.js';
import type { ResultadoDoTeste } from '../schemas/notifications.schema.js';
import { teste } from '../services/templates.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeNotificacoes {
  readonly notificacoes: ServicoDeNotificacao;
  readonly destinatarios: readonly string[];
  readonly transporte: 'log' | 'http';
}

export interface ControllerDeNotificacoes {
  testar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

export function criarControllerDeNotificacoes(
  deps: DependenciasDoControllerDeNotificacoes,
): ControllerDeNotificacoes {
  return {
    async testar(_requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      if (deps.destinatarios.length === 0) {
        await resposta
          .status(409)
          .type(TIPO_PROBLEM_JSON)
          .send(
            montarProblema(
              'notifications-not-configured',
              'Nenhum endereço de operação configurado',
              409,
              'Defina NOTIFY_OPERATOR_EMAILS para poder testar a entrega.',
            ),
          );
        return;
      }

      const inicio = Date.now();
      const entrega = await deps.notificacoes.enviar({
        tipo: 'teste',
        para: deps.destinatarios,
        corpo: teste(new Date()),
      });

      const corpo: ResultadoDoTeste = {
        transporte: deps.transporte,
        destinatarios: deps.destinatarios.length,
        resultado: entrega.ok ? 'ok' : 'erro',
        duracao_ms: Date.now() - inicio,
        ...(entrega.ok ? {} : { causa: entrega.causa }),
      };

      await resposta.status(200).send(corpo);
    },
  };
}
