/**
 * Responsabilidade: entregar por e-mail o evento de segurança da SPEC 014 — o concreto que
 * faltava para a porta `CanalDeAlerta`.
 * Consumido por: a composição, no lugar do canal de log.
 * Regras:
 *  - **Não lança** (contrato da porta): canal indisponível não pode derrubar a detecção, que
 *    por sua vez não pode derrubar a requisição que originou o fato.
 *  - **Piso de severidade.** Abaixo dele, o evento segue só para log e métrica. Caixa de
 *    entrada inundada é caixa de entrada ignorada, e o dia do alarme que importa se perde
 *    entre os outros.
 *  - **Sem a pista do sujeito**, pela mesma razão que o canal de log da 014 não a registra:
 *    ela é o que liga o alarme a uma pessoa, e caixa de e-mail de equipe é o lugar menos
 *    controlado onde esse vínculo poderia parar. Quem investiga cruza pelo id do evento.
 */
import type { CanalDeAlerta } from '../../security-events/interfaces/alerta.port.js';
import type { EventoDeSeguranca } from '../../security-events/types/security-event.js';
import type { Severidade } from '../../security-events/constants/regras.js';
import type { ServicoDeNotificacao } from './notification.service.js';
import { alertaDeSeguranca } from './templates.js';

/** Ordem de gravidade, para comparar com o piso configurado. */
const ORDEM: Readonly<Record<Severidade, number>> = { baixa: 0, media: 1, alta: 2 };

export interface OpcoesDoCanalDeEmail {
  readonly notificacoes: ServicoDeNotificacao;
  readonly destinatarios: readonly string[];
  readonly severidadeMinima: Severidade;
  readonly aoSuprimir?: () => void;
}

export function criarCanalDeEmail(opcoes: OpcoesDoCanalDeEmail): CanalDeAlerta {
  return {
    async alertar(evento: EventoDeSeguranca): Promise<void> {
      if (ORDEM[evento.severidade] < ORDEM[opcoes.severidadeMinima]) {
        opcoes.aoSuprimir?.();
        return;
      }

      await opcoes.notificacoes.enviar({
        tipo: 'alerta_de_seguranca',
        para: opcoes.destinatarios,
        corpo: alertaDeSeguranca({
          regra: evento.regra,
          severidade: evento.severidade,
          ocorrencias: evento.ocorrencias,
          janelaMs: evento.janelaMs,
          detectadoEm: evento.detectadoEm,
          eventoId: evento.id,
          traceId: evento.traceId,
        }),
      });
    },
  };
}
