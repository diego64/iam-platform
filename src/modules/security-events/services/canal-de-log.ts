/**
 * Responsabilidade: canal de alerta em log — o fallback até existir entrega de verdade.
 * Regras:
 *  - **Não registra a pista.** Ela é o que liga o alarme a uma pessoa; jogá-la no log
 *    desfaz a anonimização que o resto do módulo mantém, e log é retido e indexado por
 *    muito mais tempo que o evento.
 *  - O que vai é o suficiente para agir: regra, severidade, quantas ocorrências, em que
 *    janela, e o `trace_id` para achar a requisição que fechou o limiar.
 *  - Não lança: um canal indisponível não pode derrubar a detecção.
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { CanalDeAlerta } from '../interfaces/alerta.port.js';
import type { EventoDeSeguranca } from '../types/security-event.js';

export function criarCanalDeLog(logger: Logger): CanalDeAlerta {
  return {
    alertar(evento: EventoDeSeguranca): Promise<void> {
      logger.warn(
        {
          evento: 'security.detectado',
          regra: evento.regra,
          severidade: evento.severidade,
          tipo_de_sujeito: evento.sujeito.tipo,
          ocorrencias: evento.ocorrencias,
          janela_ms: evento.janelaMs,
          evento_id: evento.id,
          trace_id: evento.traceId,
          canal: 'log-fallback',
        },
        'security.evento_detectado — nenhum canal de alerta real configurado',
      );
      return Promise.resolve();
    },
  };
}
