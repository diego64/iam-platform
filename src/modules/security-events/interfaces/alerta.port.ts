/**
 * Porta do canal de alerta. O detector entrega o evento e não sabe se ele vira linha de log,
 * e-mail ou chamada de webhook — trocar o canal não toca em regra nenhuma.
 * Regras:
 *  - `alertar` **nunca lança**. Canal indisponível não pode derrubar a detecção, que por sua
 *    vez não pode derrubar a requisição que originou o fato.
 */
import type { EventoDeSeguranca } from '../types/security-event.js';

export interface CanalDeAlerta {
  alertar(evento: EventoDeSeguranca): Promise<void>;
}

/** Canal que não entrega nada — o default de quem não configurou canal. */
export function canalNulo(): CanalDeAlerta {
  return {
    alertar(): Promise<void> {
      return Promise.resolve();
    },
  };
}
