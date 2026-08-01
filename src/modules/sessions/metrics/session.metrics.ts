/**
 * Responsabilidade: os instrumentos de sessão — sessões ativas observadas na listagem e
 * revogações por motivo.
 * Consumido por: o serviço de sessões.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - O rótulo `motivo` é lista fechada; nunca id de sessão nem `user_agent` (cardinalidade/PII).
 */
import { metrics } from '@opentelemetry/api';
import type { MotivoDeRevogacaoDeFamilia } from '../../refresh-token/index.js';

const ESCOPO = 'iam-platform';

export interface MedidorDeSessao {
  observarAtivas(quantidade: number): void;
  contarRevogacao(motivo: MotivoDeRevogacaoDeFamilia): void;
}

export function criarMedidorDeSessao(): MedidorDeSessao {
  const meter = metrics.getMeter(ESCOPO);

  const ativas = meter.createGauge('iam_sessions_active', {
    description: 'Sessões ativas observadas a cada listagem',
  });
  const revogacoes = meter.createCounter('iam_sessions_revoked_total', {
    description: 'Sessões revogadas, por motivo',
  });

  return {
    observarAtivas(quantidade) {
      ativas.record(quantidade);
    },
    contarRevogacao(motivo) {
      revogacoes.add(1, { motivo });
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeSessaoNulo(): MedidorDeSessao {
  return {
    observarAtivas() {
      /* no-op */
    },
    contarRevogacao() {
      /* no-op */
    },
  };
}
