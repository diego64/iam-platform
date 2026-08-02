/**
 * Responsabilidade: o gauge `iam_jwks_keys{status}` — quantas chaves existem por estado.
 * Consumido por: o `JwksService`, que registra a contagem a cada carga do cache.
 * Regras:
 *  - Usa o meter do OTel diretamente. Com a telemetria desligada, `getMeter` devolve o
 *    meter no-op e todo `record` vira no-op — sem ramificação, sem custo relevante.
 *  - Rótulo `status` é lista fechada (active/next/retired); nunca entra `kid` (cardinalidade).
 */
import { metrics } from '@opentelemetry/api';
import type { StatusDaChave } from '../types/jwks.types.js';

/** Escopo — o mesmo dos demais instrumentos da aplicação. */
const ESCOPO = 'iam-platform';

export interface MedidorDeJwks {
  registrarContagem(contagem: Record<StatusDaChave, number>): void;
  /** Conta uma promoção concluída, rotulada pelo que a motivou. */
  contarRotacao(motivo: string): void;
  /** Idade da chave que assina agora — alimenta o alerta de chave velha demais. */
  registrarIdadeDaAtiva(segundos: number | null): void;
}

export function criarMedidorDeJwks(): MedidorDeJwks {
  const meter = metrics.getMeter(ESCOPO);
  const chaves = meter.createGauge('iam_jwks_keys', {
    description: 'Quantidade de chaves de assinatura por estado',
  });
  const rotacoes = meter.createCounter('iam_jwks_rotations_total', {
    description: 'Promoções de chave concluídas, por motivo',
  });
  const idadeDaAtiva = meter.createGauge('iam_jwks_active_key_age_seconds', {
    description: 'Há quantos segundos a chave ativa assina',
  });

  return {
    registrarContagem(contagem) {
      chaves.record(contagem.active, { status: 'active' });
      chaves.record(contagem.next, { status: 'next' });
      chaves.record(contagem.retired, { status: 'retired' });
    },

    contarRotacao(motivo) {
      rotacoes.add(1, { motivo });
    },

    registrarIdadeDaAtiva(segundos) {
      // Sem chave ativa não há idade a informar: gravar zero mentiria que a chave é nova,
      // que é o oposto do que o alerta procura.
      if (segundos !== null) {
        idadeDaAtiva.record(segundos);
      }
    },
  };
}

/** Medidor no-op, para testes e para o app que sobe sem telemetria. */
export function medidorDeJwksNulo(): MedidorDeJwks {
  return {
    registrarContagem() {
      /* no-op */
    },
    contarRotacao() {
      /* no-op */
    },
    registrarIdadeDaAtiva() {
      /* no-op */
    },
  };
}
