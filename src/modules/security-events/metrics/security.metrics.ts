/**
 * Responsabilidade: os instrumentos da detecção — eventos por regra, falhas do detector e o
 * tempo entre o fato e o juízo.
 * Consumido por: o detector.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos de lista fechada: regra e severidade. **Nunca** a pista — o Prometheus retém
 *    rótulo por meses, e é justamente para não reter identificador que a pista existe.
 *  - `detector_errors` tem contador próprio porque mede a plataforma **cega**: com a
 *    detecção engolindo o próprio erro, uma falha não aparece em nenhum outro lugar.
 */
import { metrics } from '@opentelemetry/api';
import type { Regra, Severidade } from '../constants/regras.js';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];

export interface MedidorDeSeguranca {
  contarEvento(regra: Regra, severidade: Severidade): void;
  contarErro(): void;
  observarDeteccao(segundos: number): void;
}

export function criarMedidorDeSeguranca(): MedidorDeSeguranca {
  const meter = metrics.getMeter(ESCOPO);

  const eventos = meter.createCounter('iam_security_events_total', {
    description: 'Eventos de segurança detectados, por regra e severidade',
  });
  const erros = meter.createCounter('iam_security_detector_errors_total', {
    description: 'Falhas do detector — a plataforma está sem esta camada',
  });
  const duracao = meter.createHistogram('iam_security_detection_duration_seconds', {
    description: 'Tempo entre o fato auditado e o juízo do detector',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarEvento(regra, severidade) {
      eventos.add(1, { regra, severidade });
    },
    contarErro() {
      erros.add(1);
    },
    observarDeteccao(segundos) {
      duracao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeSegurancaNulo(): MedidorDeSeguranca {
  return {
    contarEvento() {
      /* no-op */
    },
    contarErro() {
      /* no-op */
    },
    observarDeteccao() {
      /* no-op */
    },
  };
}
