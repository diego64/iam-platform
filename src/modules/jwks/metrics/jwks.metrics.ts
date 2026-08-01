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
}

export function criarMedidorDeJwks(): MedidorDeJwks {
  const meter = metrics.getMeter(ESCOPO);
  const chaves = meter.createGauge('iam_jwks_keys', {
    description: 'Quantidade de chaves de assinatura por estado',
  });

  return {
    registrarContagem(contagem) {
      chaves.record(contagem.active, { status: 'active' });
      chaves.record(contagem.next, { status: 'next' });
      chaves.record(contagem.retired, { status: 'retired' });
    },
  };
}

/** Medidor no-op, para testes e para o app que sobe sem telemetria. */
export function medidorDeJwksNulo(): MedidorDeJwks {
  return {
    registrarContagem() {
      /* no-op */
    },
  };
}
