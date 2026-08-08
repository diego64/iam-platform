/**
 * Responsabilidade: os instrumentos do segundo fator — desafios criados, verificações por
 * método e resultado, etapas de cadastro e códigos repetidos.
 * Consumido por: o serviço de desafio e o de MFA.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos de lista fechada. Nunca `user_id`, nunca código — cardinalidade e PII.
 *  - `replay_blocked` tem contador próprio: um código correto reapresentado depois de
 *    consumido é sinal de interceptação, não de erro de digitação, e é o tipo de evento que
 *    merece alerta em vez de virar linha num rótulo genérico.
 */
import { metrics } from '@opentelemetry/api';

const ESCOPO = 'iam-platform';

export type MetodoDeVerificacao = 'totp' | 'recovery';
export type ResultadoDeVerificacao = 'success' | 'failure';
export type EtapaDeCadastro = 'started' | 'confirmed' | 'disabled' | 'reset';

const FRONTEIRAS_SEGUNDOS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

export interface MedidorDeMfa {
  contarDesafio(): void;
  contarVerificacao(metodo: MetodoDeVerificacao, resultado: ResultadoDeVerificacao): void;
  contarCadastro(etapa: EtapaDeCadastro): void;
  contarReplayBloqueado(): void;
  observarVerificacao(segundos: number): void;
}

export function criarMedidorDeMfa(): MedidorDeMfa {
  const meter = metrics.getMeter(ESCOPO);

  const desafios = meter.createCounter('iam_mfa_challenges_total', {
    description: 'Logins que pararam no primeiro fator e geraram desafio',
  });
  const verificacoes = meter.createCounter('iam_mfa_verifications_total', {
    description: 'Verificações de segundo fator, por método e resultado',
  });
  const cadastros = meter.createCounter('iam_mfa_enrollments_total', {
    description: 'Etapas do ciclo de vida do fator',
  });
  const replays = meter.createCounter('iam_mfa_replay_blocked_total', {
    description: 'Códigos corretos recusados por já terem sido usados (indício de intercepção)',
  });
  const duracao = meter.createHistogram('iam_mfa_verify_duration_seconds', {
    description: 'Duração da verificação do segundo fator',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarDesafio() {
      desafios.add(1);
    },
    contarVerificacao(metodo, resultado) {
      verificacoes.add(1, { metodo, resultado });
    },
    contarCadastro(etapa) {
      cadastros.add(1, { etapa });
    },
    contarReplayBloqueado() {
      replays.add(1);
    },
    observarVerificacao(segundos) {
      duracao.record(segundos);
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeMfaNulo(): MedidorDeMfa {
  return {
    contarDesafio() {
      /* no-op */
    },
    contarVerificacao() {
      /* no-op */
    },
    contarCadastro() {
      /* no-op */
    },
    contarReplayBloqueado() {
      /* no-op */
    },
    observarVerificacao() {
      /* no-op */
    },
  };
}
