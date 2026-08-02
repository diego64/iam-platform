/**
 * Responsabilidade: os instrumentos de clientes de API — autenticações, administração e a
 * contagem por estado.
 * Consumido por: o serviço de clientes e o de autenticação de cliente.
 * Regras:
 *  - Usa o meter do OTel diretamente. Com a telemetria desligada, `getMeter` devolve o
 *    meter no-op e todo `add` vira no-op — sem ramificação, sem custo relevante.
 *  - Rótulos são listas fechadas. `client_id` jamais vira rótulo: seria uma série de
 *    métrica por cliente, e o número de clientes é justamente o que cresce.
 */
import { metrics } from '@opentelemetry/api';
import type { StatusDoCliente } from '../types/api-client.types.js';

const ESCOPO = 'iam-platform';

/** Por que a autenticação de cliente falhou. Lista fechada — vira rótulo. */
export type MotivoDeFalhaDeCliente =
  'unknown_client' | 'bad_secret' | 'disabled' | 'expired_previous';

export interface MedidorDeClientes {
  contarFalhaDeAutenticacao(motivo: MotivoDeFalhaDeCliente): void;
  contarSucessoDeAutenticacao(): void;
  registrarContagem(contagem: Record<StatusDoCliente, number>): void;
  contarCriacao(): void;
  contarAtualizacao(): void;
  contarRemocao(): void;
  contarRotacaoDeSegredo(): void;
}

export function criarMedidorDeClientes(): MedidorDeClientes {
  const meter = metrics.getMeter(ESCOPO);
  const falhas = meter.createCounter('iam_client_auth_failures_total', {
    description: 'Falhas de autenticação de cliente de API, por motivo',
  });
  const sucessos = meter.createCounter('iam_client_auth_success_total', {
    description: 'Autenticações de cliente de API bem-sucedidas',
  });
  const clientes = meter.createGauge('iam_api_clients', {
    description: 'Quantidade de clientes de API por estado',
  });
  const administracao = meter.createCounter('iam_api_clients_admin_total', {
    description: 'Operações administrativas sobre clientes, por operação',
  });

  return {
    contarFalhaDeAutenticacao(motivo) {
      falhas.add(1, { motivo });
    },
    contarSucessoDeAutenticacao() {
      sucessos.add(1);
    },
    registrarContagem(contagem) {
      clientes.record(contagem.active, { status: 'active' });
      clientes.record(contagem.disabled, { status: 'disabled' });
      clientes.record(contagem.deleted, { status: 'deleted' });
    },
    contarCriacao() {
      administracao.add(1, { operacao: 'create' });
    },
    contarAtualizacao() {
      administracao.add(1, { operacao: 'update' });
    },
    contarRemocao() {
      administracao.add(1, { operacao: 'delete' });
    },
    contarRotacaoDeSegredo() {
      administracao.add(1, { operacao: 'rotate_secret' });
    },
  };
}

/** Medidor no-op, para testes e para o app que sobe sem telemetria. */
export function medidorDeClientesNulo(): MedidorDeClientes {
  return {
    contarFalhaDeAutenticacao() {
      /* no-op */
    },
    contarSucessoDeAutenticacao() {
      /* no-op */
    },
    registrarContagem() {
      /* no-op */
    },
    contarCriacao() {
      /* no-op */
    },
    contarAtualizacao() {
      /* no-op */
    },
    contarRemocao() {
      /* no-op */
    },
    contarRotacaoDeSegredo() {
      /* no-op */
    },
  };
}
