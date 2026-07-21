/**
 * Responsabilidade: os contadores de operação administrativa de usuário.
 * Consumido por: o controller, que registra o desfecho de cada operação.
 * Regras:
 *  - Usa o meter do OTel diretamente. Com a telemetria desligada, `getMeter` devolve o
 *    meter no-op e todo `add` vira no-op — sem ramificação, sem custo relevante.
 *  - Rótulo é lista fechada (`resultado`): dado sensível nunca entra em métrica, que o
 *    Prometheus retém por meses.
 */
import { metrics } from '@opentelemetry/api';

/** Escopo — o mesmo dos demais instrumentos da aplicação. */
const ESCOPO = 'iam-platform';

export type ResultadoDeOperacao = 'ok' | 'erro';

export interface MedidorDeUsuarios {
  contarCriacao(): void;
  contarBloqueio(resultado: ResultadoDeOperacao): void;
  contarRemocao(): void;
}

export function criarMedidorDeUsuarios(): MedidorDeUsuarios {
  const meter = metrics.getMeter(ESCOPO);

  const criados = meter.createCounter('iam_users_created_total', {
    description: 'Usuários criados',
  });
  const bloqueados = meter.createCounter('iam_users_blocked_total', {
    description: 'Tentativas de bloqueio de usuário, por resultado',
  });
  const removidos = meter.createCounter('iam_users_deleted_total', {
    description: 'Usuários removidos',
  });

  return {
    contarCriacao() {
      criados.add(1);
    },
    contarBloqueio(resultado) {
      bloqueados.add(1, { resultado });
    },
    contarRemocao() {
      removidos.add(1);
    },
  };
}

/** Medidor no-op, para os testes e o app que sobem sem telemetria. */
export function medidorDeUsuariosNulo(): MedidorDeUsuarios {
  return {
    contarCriacao() {
      /* no-op */
    },
    contarBloqueio() {
      /* no-op */
    },
    contarRemocao() {
      /* no-op */
    },
  };
}
