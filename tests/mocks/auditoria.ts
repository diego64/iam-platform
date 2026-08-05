/**
 * Registrador de auditoria em memória.
 *
 * Guarda o que cada serviço tentou registrar, para o teste afirmar sobre o evento — tipo,
 * ator, alvo e motivo — sem precisar de Mongo nem do encadeamento real.
 */
import type { RegistradorDeAuditoria } from '../../src/modules/audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../src/modules/audit/types/audit-event.js';

export interface RegistradorFake extends RegistradorDeAuditoria {
  readonly eventos: EventoDeAuditoria[];
  /** Os tipos registrados, na ordem — o formato mais direto de afirmar sobre a sequência. */
  tipos(): string[];
  doTipo(tipo: string): EventoDeAuditoria | undefined;
}

export function criarRegistradorFake(): RegistradorFake {
  const eventos: EventoDeAuditoria[] = [];

  return {
    eventos,
    registrar(evento) {
      eventos.push(evento);
      return Promise.resolve();
    },
    tipos: () => eventos.map((evento) => evento.type),
    doTipo: (tipo) => eventos.find((evento) => evento.type === tipo),
  };
}
