/**
 * Responsabilidade: converter o evento persistido no objeto que a API devolve.
 * Regras: campo a campo, sem espalhar o documento. A trilha guarda o elo anterior e o
 * `_id`; nenhum dos dois pertence à resposta da listagem, e um espalhamento os levaria
 * junto na primeira vez que alguém acrescentasse um campo interno.
 */
import type { EventoPersistido } from '../types/audit-event.js';

export interface EventoDTO {
  readonly seq: number;
  readonly event_id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: {
    readonly id: string | null;
    readonly type: string;
    readonly ip?: string;
    readonly user_agent?: string;
  };
  readonly target: { readonly id: string; readonly type: string } | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly subject_hint: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly request_id: string | null;
  readonly trace_id: string | null;
  readonly hash: string;
}

export interface EventoDetalheDTO extends EventoDTO {
  readonly prev_hash: string;
}

export function eventoParaDTO(evento: EventoPersistido): EventoDTO {
  return {
    seq: evento.seq,
    event_id: evento.eventId,
    type: evento.type,
    occurred_at: evento.occurredAt.toISOString(),
    actor: {
      id: evento.actor.id,
      type: evento.actor.type,
      ...(evento.actor.ip === undefined ? {} : { ip: evento.actor.ip }),
      ...(evento.actor.userAgent === undefined ? {} : { user_agent: evento.actor.userAgent }),
    },
    target: evento.target,
    outcome: evento.outcome,
    reason: evento.reason,
    subject_hint: evento.subjectHint,
    metadata: evento.metadata,
    request_id: evento.requestId,
    trace_id: evento.traceId,
    hash: evento.hash,
  };
}

export function eventoParaDetalheDTO(evento: EventoPersistido): EventoDetalheDTO {
  return { ...eventoParaDTO(evento), prev_hash: evento.prevHash };
}
