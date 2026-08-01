/**
 * Responsabilidade: os instrumentos de autenticação — falhas/sucessos de login e a duração
 * da validação de token.
 * Consumido por: o `AuthService` (login) e o middleware de verificação.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulo `motivo` é lista fechada — nunca e-mail nem id (cardinalidade e PII).
 */
import { metrics } from '@opentelemetry/api';

const ESCOPO = 'iam-platform';

/** Por que o login falhou — genérico, nunca revela qual conta. */
export type MotivoDeFalha = 'desconhecido' | 'senha' | 'bloqueado';

const FRONTEIRAS_SEGUNDOS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25];

export interface MedidorDeAuth {
  contarFalha(motivo: MotivoDeFalha): void;
  contarSucesso(): void;
  observarValidacao(segundos: number): void;
}

export function criarMedidorDeAuth(): MedidorDeAuth {
  const meter = metrics.getMeter(ESCOPO);

  const falhas = meter.createCounter('iam_login_failures_total', {
    description: 'Tentativas de login malsucedidas, por motivo',
  });
  const sucessos = meter.createCounter('iam_login_success_total', {
    description: 'Logins bem-sucedidos',
  });
  const validacao = meter.createHistogram('iam_token_validation_duration_seconds', {
    description: 'Duração da validação de access token',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarFalha(motivo) {
      falhas.add(1, { motivo });
    },
    contarSucesso() {
      sucessos.add(1);
    },
    observarValidacao(segundos) {
      validacao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeAuthNulo(): MedidorDeAuth {
  return {
    contarFalha() {
      /* no-op */
    },
    contarSucesso() {
      /* no-op */
    },
    observarValidacao() {
      /* no-op */
    },
  };
}
