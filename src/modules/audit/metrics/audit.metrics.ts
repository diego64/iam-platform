/**
 * Responsabilidade: os instrumentos da trilha — eventos escritos, falhas de escrita,
 * contenção do topo, duração da escrita e a posição da última âncora.
 * Consumido por: o serviço de auditoria.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - Rótulos são listas fechadas (tipo de evento, resultado, motivo da falha). Id de
 *    usuário, e-mail e caminho de requisição ficam de fora: cardinalidade e PII.
 *  - Falha de escrita é o contador que mais importa. Auditoria cega não avisa sozinha que
 *    parou de enxergar; é o alerta em cima deste número que avisa.
 */
import { metrics } from '@opentelemetry/api';
import type { ResultadoDeEvento, TipoDeEvento } from '../constants/event-types.js';

const ESCOPO = 'iam-platform';

/** Por que a escrita falhou — lista fechada. */
export type MotivoDeFalhaDeAuditoria = 'metadata-proibida' | 'escrita' | 'contencao';

const FRONTEIRAS_SEGUNDOS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25];

export interface MedidorDeAuditoria {
  contarEvento(tipo: TipoDeEvento, resultado: ResultadoDeEvento): void;
  contarFalha(motivo: MotivoDeFalhaDeAuditoria): void;
  contarConflito(quantidade: number): void;
  observarEscrita(segundos: number): void;
  registrarCheckpoint(seq: number): void;
}

export function criarMedidorDeAuditoria(): MedidorDeAuditoria {
  const meter = metrics.getMeter(ESCOPO);

  const eventos = meter.createCounter('iam_audit_events_total', {
    description: 'Eventos persistidos na trilha, por tipo e resultado',
  });
  const falhas = meter.createCounter('iam_audit_write_failures_total', {
    description: 'Escritas de auditoria que não chegaram à trilha, por motivo',
  });
  const conflitos = meter.createCounter('iam_audit_chain_conflicts_total', {
    description: 'Voltas perdidas na disputa pelo topo da cadeia',
  });
  const escrita = meter.createHistogram('iam_audit_write_duration_seconds', {
    description: 'Duração da escrita de um evento na trilha',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  // Gauge assíncrono seria observado em intervalo fixo; aqui o valor só muda quando uma
  // âncora é gravada, então o registro é feito no momento em que isso acontece.
  let ultimoCheckpoint = 0;
  const checkpoint = meter.createObservableGauge('iam_audit_last_checkpoint_seq', {
    description: 'Posição da última âncora gravada no PostgreSQL',
  });
  checkpoint.addCallback((observador) => {
    observador.observe(ultimoCheckpoint);
  });

  return {
    contarEvento(tipo, resultado) {
      eventos.add(1, { tipo, resultado });
    },
    contarFalha(motivo) {
      falhas.add(1, { motivo });
    },
    contarConflito(quantidade) {
      if (quantidade > 0) conflitos.add(quantidade);
    },
    observarEscrita(segundos) {
      escrita.record(segundos);
    },
    registrarCheckpoint(seq) {
      ultimoCheckpoint = seq;
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeAuditoriaNulo(): MedidorDeAuditoria {
  return {
    contarEvento() {
      /* no-op */
    },
    contarFalha() {
      /* no-op */
    },
    contarConflito() {
      /* no-op */
    },
    observarEscrita() {
      /* no-op */
    },
    registrarCheckpoint() {
      /* no-op */
    },
  };
}
