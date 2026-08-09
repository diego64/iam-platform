/**
 * Responsabilidade: extrair de um evento de auditoria a pista que cada regra correlaciona.
 * Consumido por: as regras de detecção.
 * Regras:
 *  - A pista é derivada **com o mesmo pepper** que o serviço de auditoria usa para o
 *    `subject_hint`. É de propósito: o valor tem de bater, senão quem investigar não
 *    consegue cruzar um evento de segurança com a trilha, que é o único caminho para
 *    descobrir de quem se trata.
 *  - O e-mail em claro **passa** por este módulo — ele vem no evento de entrada, antes de a
 *    trilha o transformar em pista. O que a SPEC garante é que ele não é **persistido**:
 *    daqui só sai digest, e nem o log nem a coleção de eventos recebem o valor original.
 *  - Evento que não tem o que a regra precisa devolve `null`: sujeito vazio viraria um balde
 *    onde tentativas de gente diferente se somam.
 */
import { createHash } from 'node:crypto';
import type { EventoDeAuditoria } from '../../audit/types/audit-event.js';
import type { SujeitoDeSeguranca } from '../types/security-event.js';

export interface ExtratorDeSujeito {
  /** A conta alvo da tentativa. */
  daConta(evento: EventoDeAuditoria): SujeitoDeSeguranca | null;
  /** A origem da requisição. */
  doIp(evento: EventoDeAuditoria): SujeitoDeSeguranca | null;
  /** O ator, quando ele é identificável (cliente de API ou usuário autenticado). */
  doAtor(evento: EventoDeAuditoria): SujeitoDeSeguranca | null;
}

export function criarExtratorDeSujeito(pepper: string): ExtratorDeSujeito {
  /** Mesma fórmula do `derivarPista` do serviço de auditoria — os valores precisam bater. */
  function derivar(valor: string): string {
    return createHash('sha256').update(`${valor}:${pepper}`, 'utf8').digest('hex');
  }

  return {
    daConta(evento): SujeitoDeSeguranca | null {
      const email = evento.subjectEmail;
      if (email === undefined || email.trim().length === 0) return null;
      return { tipo: 'conta', pista: derivar(email.trim().toLowerCase()) };
    },

    doIp(evento): SujeitoDeSeguranca | null {
      const ip = evento.actor.ip;
      if (ip === undefined || ip.length === 0) return null;
      return { tipo: 'ip', pista: derivar(ip) };
    },

    doAtor(evento): SujeitoDeSeguranca | null {
      const id = evento.actor.id;
      if (id === null || id.length === 0) return null;
      return {
        tipo: evento.actor.type === 'client' ? 'cliente' : 'usuario',
        pista: derivar(id),
      };
    },
  };
}
