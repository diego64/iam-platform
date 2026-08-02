/**
 * Responsabilidade: os instrumentos de decisão de política — contagem por efeito e duração
 * da avaliação.
 * Consumido por: o motor PDP.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos são `effect` (permit|deny) e `resource_type` (lista fechada de tipos de recurso
 *    declarados nas rotas) — nunca id de sujeito, de recurso ou valor de atributo, senão a
 *    cardinalidade explode e a série passa a carregar dado de usuário.
 *  - A duração mede só a avaliação, sem o I/O de `carregarRecurso`: misturar os dois
 *    esconderia o custo da decisão atrás da latência do banco, e são dois orçamentos de
 *    latência diferentes: a avaliação tem teto de milissegundos, a carga do recurso não.
 */
import { metrics } from '@opentelemetry/api';
import type { Efeito } from '../types/abac.types.js';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025];

export interface MedidorDeAbac {
  contarDecisao(effect: Efeito, resourceType: string): void;
  observarAvaliacao(segundos: number): void;
}

export function criarMedidorDeAbac(): MedidorDeAbac {
  const meter = metrics.getMeter(ESCOPO);

  const decisoes = meter.createCounter('iam_policy_decisions_total', {
    description: 'Decisões de política, por efeito e tipo de recurso',
  });
  const avaliacao = meter.createHistogram('iam_policy_evaluation_duration_seconds', {
    description: 'Duração da avaliação de políticas pelo PDP (sem I/O de recurso)',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarDecisao(effect, resourceType) {
      decisoes.add(1, { effect, resource_type: resourceType });
    },
    observarAvaliacao(segundos) {
      avaliacao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeAbacNulo(): MedidorDeAbac {
  return {
    contarDecisao() {
      /* no-op */
    },
    observarAvaliacao() {
      /* no-op */
    },
  };
}
