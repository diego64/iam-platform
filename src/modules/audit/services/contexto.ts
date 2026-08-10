/**
 * Responsabilidade: completar o evento com o que a requisição sabe e o emissor não — origem
 * (ip, user-agent) e quem estava autenticado.
 * Consumido por: o serviço de auditoria, na hora de persistir, e os decoradores da porta, que
 * precisam entregar aos observadores o mesmo evento que vai para a trilha.
 * Regras:
 *  - Existe uma vez só de propósito. Enquanto o enriquecimento morava dentro do serviço, quem
 *    decorava a porta entregava aos observadores o evento **cru** — sem ip e sem user-agent,
 *    porque nenhum emissor os preenche. A regra que dependia do IP não via IP nenhum e
 *    silenciosamente nunca disparava.
 *  - O emissor tem prioridade: o que ele afirma não é sobrescrito pelo contexto. Serviço
 *    administrativo que age em nome de outro ator continua descrevendo o ator certo.
 *  - Fora de requisição — tarefa agendada, boot, teste unitário — não há contexto, e o evento
 *    volta como veio. Ausência é ausência, não erro.
 *  - Idempotente: aplicar duas vezes dá o mesmo resultado, porque o decorador enriquece antes
 *    de delegar e o serviço enriquece de novo antes de gravar.
 */
import { contextoDeRequisicao } from '../../../shared/context/request-context.js';
import type { EventoDeAuditoria } from '../types/audit-event.js';

export function enriquecerComContexto(evento: EventoDeAuditoria): EventoDeAuditoria {
  const contexto = contextoDeRequisicao();
  if (contexto === undefined) return evento;

  const ip = evento.actor.ip ?? contexto.ip;
  const userAgent = evento.actor.userAgent ?? contexto.userAgent;
  const id = evento.actor.id ?? contexto.atorId ?? null;

  return {
    ...evento,
    actor: {
      id,
      type: evento.actor.type,
      ...(ip === undefined ? {} : { ip }),
      ...(userAgent === undefined ? {} : { userAgent }),
    },
  };
}
