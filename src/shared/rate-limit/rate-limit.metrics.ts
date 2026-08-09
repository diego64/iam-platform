/**
 * Responsabilidade: os instrumentos do rate limit — bloqueios por rota e dimensão, falhas do
 * contador e o custo dele no caminho da requisição.
 * Consumido por: a política de limite.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos de lista fechada: rota e dimensão. **Nunca** IP, e-mail ou `client_id` — o
 *    Prometheus retém rótulo por meses, e identificador que entra ali não sai por expiração
 *    de sessão.
 *  - `store_errors` tem contador próprio porque ele mede a plataforma **cega**: com fail
 *    open, uma falha do contador não aparece em lugar nenhum além daqui.
 */
import { metrics } from '@opentelemetry/api';
import type { DimensaoDeLimite } from './types.js';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1];

export interface MedidorDeRateLimit {
  contarBloqueio(rota: string, dimensao: DimensaoDeLimite): void;
  contarErroDoContador(): void;
  observarDuracao(segundos: number): void;
}

export function criarMedidorDeRateLimit(): MedidorDeRateLimit {
  const meter = metrics.getMeter(ESCOPO);

  const bloqueios = meter.createCounter('iam_rate_limit_hits_total', {
    description: 'Requisições barradas por rate limit, por rota e dimensão',
  });
  const erros = meter.createCounter('iam_rate_limit_store_errors_total', {
    description: 'Falhas do contador de rate limit — a plataforma está sem esta camada',
  });
  const duracao = meter.createHistogram('iam_rate_limit_store_duration_seconds', {
    description: 'Custo do contador no caminho da requisição',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarBloqueio(rota, dimensao) {
      bloqueios.add(1, { rota, dimensao });
    },
    contarErroDoContador() {
      erros.add(1);
    },
    observarDuracao(segundos) {
      duracao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeRateLimitNulo(): MedidorDeRateLimit {
  return {
    contarBloqueio() {
      /* no-op */
    },
    contarErroDoContador() {
      /* no-op */
    },
    observarDuracao() {
      /* no-op */
    },
  };
}
