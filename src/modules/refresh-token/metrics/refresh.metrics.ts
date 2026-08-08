/**
 * Responsabilidade: os instrumentos do refresh token — rotações, reusos detectados, falhas
 * por motivo e a duração da rotação.
 * Consumido por: o `RefreshTokenService`.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulo `motivo` é lista fechada — nunca id nem token (cardinalidade e PII).
 *  - `reuso` tem contador próprio: é sinal de roubo, alvo de alerta de segurança.
 */
import { metrics } from '@opentelemetry/api';

const ESCOPO = 'iam-platform';

/** Por que a rotação falhou — genérico, nunca revela o dono do token. */
export type MotivoDeFalhaDeRefresh =
  | 'nao_encontrado'
  | 'idle_expirado'
  | 'absoluto_expirado'
  | 'usuario_bloqueado'
  | 'cliente_divergente';

const FRONTEIRAS_SEGUNDOS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25];

export interface MedidorDeRefresh {
  contarRotacao(): void;
  contarReuso(): void;
  contarFalha(motivo: MotivoDeFalhaDeRefresh): void;
  observarDuracao(segundos: number): void;
}

export function criarMedidorDeRefresh(): MedidorDeRefresh {
  const meter = metrics.getMeter(ESCOPO);

  const rotacoes = meter.createCounter('iam_refresh_rotations_total', {
    description: 'Rotações de refresh token bem-sucedidas',
  });
  const reusos = meter.createCounter('iam_refresh_reuse_detected_total', {
    description: 'Famílias derrubadas por reuso de refresh token (indício de roubo)',
  });
  const falhas = meter.createCounter('iam_refresh_failures_total', {
    description: 'Rotações recusadas, por motivo',
  });
  const duracao = meter.createHistogram('iam_refresh_duration_seconds', {
    description: 'Duração da rotação de refresh token',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarRotacao() {
      rotacoes.add(1);
    },
    contarReuso() {
      reusos.add(1);
    },
    contarFalha(motivo) {
      falhas.add(1, { motivo });
    },
    observarDuracao(segundos) {
      duracao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeRefreshNulo(): MedidorDeRefresh {
  return {
    contarRotacao() {
      /* no-op */
    },
    contarReuso() {
      /* no-op */
    },
    contarFalha() {
      /* no-op */
    },
    observarDuracao() {
      /* no-op */
    },
  };
}
