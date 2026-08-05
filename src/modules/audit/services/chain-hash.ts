/**
 * Responsabilidade: o cálculo do elo da cadeia — o mesmo, para quem escreve e para quem
 * verifica.
 * Consumido por: o serviço de auditoria (ao anexar) e o de integridade (ao recomputar).
 * Regras:
 *  - Uma função só. Duas implementações do mesmo hash divergiriam em algum detalhe de
 *    serialização, e a verificação passaria a acusar adulteração em trilha honesta.
 *  - O corpo canonicalizado usa exatamente os nomes de campo do documento persistido: quem
 *    tiver a coleção em mãos reproduz o hash sem conhecer o código.
 *  - `seq` e `prev_hash` entram fora do corpo, como prefixo — é o que amarra o evento à
 *    posição e ao elo anterior. Sem eles, mover um evento de lugar não mudaria o hash.
 */
import { createHash } from 'node:crypto';
import { canonicalizar, type ValorCanonico } from '../../../shared/utils/canonical-json.js';
import type { EventoPersistido } from '../types/audit-event.js';
import type { EventoParaAnexar } from '../repositories/audit-log.repository.js';

/** O evento sem posição e sem encadeamento — o que entra no hash. */
export type CorpoDoEvento = EventoParaAnexar;

/** Espelha o documento persistido, para o hash ser reproduzível a partir da coleção. */
function paraFormaCanonica(corpo: CorpoDoEvento): ValorCanonico {
  return {
    event_id: corpo.eventId,
    type: corpo.type,
    occurred_at: corpo.occurredAt,
    actor: {
      id: corpo.actor.id,
      type: corpo.actor.type,
      ip: corpo.actor.ip,
      user_agent: corpo.actor.userAgent,
    },
    target: corpo.target === null ? null : { id: corpo.target.id, type: corpo.target.type },
    outcome: corpo.outcome,
    reason: corpo.reason,
    subject_hint: corpo.subjectHint,
    metadata: corpo.metadata,
    request_id: corpo.requestId,
    trace_id: corpo.traceId,
  };
}

export function calcularHashDoElo(seq: number, prevHash: string, corpo: CorpoDoEvento): string {
  return createHash('sha256')
    .update(`${String(seq)}:${prevHash}:${canonicalizar(paraFormaCanonica(corpo))}`, 'utf8')
    .digest('hex');
}

/** Extrai de um evento persistido o corpo que entrou no hash, para recomputá-lo. */
export function corpoDe(evento: EventoPersistido): CorpoDoEvento {
  return {
    eventId: evento.eventId,
    type: evento.type,
    occurredAt: evento.occurredAt,
    actor: evento.actor,
    target: evento.target,
    outcome: evento.outcome,
    reason: evento.reason,
    subjectHint: evento.subjectHint,
    metadata: evento.metadata,
    requestId: evento.requestId,
    traceId: evento.traceId,
  };
}
