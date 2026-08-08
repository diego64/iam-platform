/**
 * Responsabilidade: os instrumentos do painel — requisições, revogações, respostas parciais
 * e o custo da agregação.
 * Consumido por: os serviços e o controller do painel.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos são listas fechadas (rota, resultado, escopo, fonte). Id de usuário fica de
 *    fora: uma série por usuário administrado derrubaria o Prometheus.
 *  - A resposta parcial é contada por fonte. Degradação silenciosa é pior que erro: sem este
 *    contador, o painel mostraria campos vazios por semanas sem ninguém perceber.
 */
import { metrics } from '@opentelemetry/api';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

export type VisaoAgregada = 'overview' | 'usuario';

export interface MedidorDeAdmin {
  contarRequisicao(rota: string, resultado: number): void;
  contarRevogacao(escopo: 'uma' | 'todas'): void;
  contarParcial(fonte: string): void;
  observarAgregacao(visao: VisaoAgregada, segundos: number): void;
}

export function criarMedidorDeAdmin(): MedidorDeAdmin {
  const meter = metrics.getMeter(ESCOPO);

  const requisicoes = meter.createCounter('iam_admin_requests_total', {
    description: 'Requisições às rotas administrativas, por rota e status',
  });
  const revogacoes = meter.createCounter('iam_admin_sessions_revoked_total', {
    description: 'Sessões revogadas por um administrador, por alcance',
  });
  const parciais = meter.createCounter('iam_admin_partial_responses_total', {
    description: 'Respostas administrativas degradadas, por fonte indisponível',
  });
  const agregacao = meter.createHistogram('iam_admin_aggregation_duration_seconds', {
    description: 'Duração da agregação de uma visão administrativa',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarRequisicao(rota, resultado) {
      requisicoes.add(1, { rota, resultado });
    },
    contarRevogacao(escopo) {
      revogacoes.add(1, { escopo });
    },
    contarParcial(fonte) {
      parciais.add(1, { fonte });
    },
    observarAgregacao(visao, segundos) {
      agregacao.record(segundos, { visao });
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeAdminNulo(): MedidorDeAdmin {
  return {
    contarRequisicao() {
      /* no-op */
    },
    contarRevogacao() {
      /* no-op */
    },
    contarParcial() {
      /* no-op */
    },
    observarAgregacao() {
      /* no-op */
    },
  };
}
