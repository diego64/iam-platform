/**
 * Responsabilidade: os instrumentos da entrega — o que saiu, o que falhou, o que foi calado
 * e quanto demorou.
 * Consumido por: o serviço de notificação e os dois canais.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos de lista fechada: tipo, resultado e motivo. **Nunca** o destinatário — nem em
 *    digest: rótulo é retido por meses e multiplica série por usuário.
 *  - `suprimidas` existe para dar diagnóstico ao silêncio. Sem ele, "não recebi o e-mail" é
 *    indistinguível de um canal quebrado, e os dois pedem ações opostas.
 *  - `falhas` tem contador próprio porque mede a plataforma **muda**: ela parece avisando, e
 *    ninguém do lado de fora percebe que não está.
 */
import { metrics } from '@opentelemetry/api';
import type { MotivoDeSupressao, TipoDeNotificacao } from '../constants/tipos.js';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

export interface MedidorDeNotificacoes {
  contarEnvio(tipo: TipoDeNotificacao, resultado: 'ok' | 'erro'): void;
  contarFalha(): void;
  contarSupressao(tipo: TipoDeNotificacao, motivo: MotivoDeSupressao): void;
  observarEntrega(segundos: number): void;
}

export function criarMedidorDeNotificacoes(): MedidorDeNotificacoes {
  const meter = metrics.getMeter(ESCOPO);

  const enviadas = meter.createCounter('iam_notifications_sent_total', {
    description: 'Mensagens entregues ao transporte, por tipo e resultado',
  });
  const falhas = meter.createCounter('iam_notifications_failures_total', {
    description: 'Falhas de entrega — a plataforma parece avisando e não está',
  });
  const suprimidas = meter.createCounter('iam_notifications_suppressed_total', {
    description: 'Mensagens deliberadamente não enviadas, por motivo',
  });
  const duracao = meter.createHistogram('iam_notifications_delivery_duration_seconds', {
    description: 'Tempo da tentativa de entrega',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarEnvio(tipo, resultado) {
      enviadas.add(1, { tipo, resultado });
    },
    contarFalha() {
      falhas.add(1);
    },
    contarSupressao(tipo, motivo) {
      suprimidas.add(1, { tipo, motivo });
    },
    observarEntrega(segundos) {
      duracao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeNotificacoesNulo(): MedidorDeNotificacoes {
  return {
    contarEnvio() {
      /* no-op */
    },
    contarFalha() {
      /* no-op */
    },
    contarSupressao() {
      /* no-op */
    },
    observarEntrega() {
      /* no-op */
    },
  };
}
