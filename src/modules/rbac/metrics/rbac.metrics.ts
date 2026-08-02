/**
 * Responsabilidade: os instrumentos de autorização — negações do guard e a duração da
 * verificação.
 * Consumido por: o guard `exigirPermissao`/`exigirPapel`.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulo `permissao` é a permissão exigida (lista fechada de nomes de recurso:acao),
 *    nunca id de usuário nem valor de header — cardinalidade e PII sob controle.
 */
import { metrics } from '@opentelemetry/api';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01];

export interface MedidorDeRbac {
  contarNegacao(permissao: string): void;
  observarVerificacao(segundos: number): void;
}

export function criarMedidorDeRbac(): MedidorDeRbac {
  const meter = metrics.getMeter(ESCOPO);

  const negacoes = meter.createCounter('iam_authorization_denied_total', {
    description: 'Verificações de autorização negadas, por permissão exigida',
  });
  const verificacao = meter.createHistogram('iam_authorization_check_duration_seconds', {
    description: 'Duração da verificação de autorização (guard)',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarNegacao(permissao) {
      negacoes.add(1, { permissao });
    },
    observarVerificacao(segundos) {
      verificacao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeRbacNulo(): MedidorDeRbac {
  return {
    contarNegacao() {
      /* no-op */
    },
    observarVerificacao() {
      /* no-op */
    },
  };
}
