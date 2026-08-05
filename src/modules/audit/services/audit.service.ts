/**
 * Responsabilidade: transformar o evento que um módulo descreve no evento que a trilha
 * guarda — instante, identificador, correlação, hash do elo e âncora periódica.
 * Consumido por: todos os módulos que registram operação sensível, pela porta de registro.
 * Regras:
 *  - `registrar` **nunca lança**. A operação que gerou o evento já foi efetivada; derrubá-la
 *    porque a trilha não respondeu trocaria um problema de observação por um de negócio.
 *    Falha vira log em `error` com o evento íntegro — o Loki passa a ser o rastro — mais o
 *    contador que dispara o alerta.
 *  - Segredo não entra: `metadata` com chave sensível é recusado antes da escrita, e o log
 *    dessa recusa carrega só os nomes das chaves, nunca os valores.
 *  - Quando não há ator identificado, o e-mail digitado não é guardado: o que vai para a
 *    trilha é o sha256 dele com pepper, que ainda permite correlacionar tentativas contra o
 *    mesmo alvo sem transformar a coleção num depósito de e-mails de terceiros.
 *  - A âncora é gravada fora do caminho crítico: falhar ao ancorar não desfaz o evento, que
 *    já está na trilha.
 */
import { createHash } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Logger } from '../../../shared/logger/index.js';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';
import { contextoDeRequisicao } from '../../../shared/context/request-context.js';
import { FRAGMENTOS_PROIBIDOS_EM_METADATA } from '../constants/event-types.js';
import { ErroDeAuditoria } from '../errors/audit.errors.js';
import type { RegistradorDeAuditoria } from '../interfaces/audit-recorder.js';
import type { EventoDeAuditoria, ValorDeMetadata } from '../types/audit-event.js';
import type {
  EventoParaAnexar,
  RepositorioDaTrilha,
} from '../repositories/audit-log.repository.js';
import type { RepositorioDeCheckpoint } from '../repositories/audit-checkpoint.repository.js';
import { calcularHashDoElo } from './chain-hash.js';
import { medidorDeAuditoriaNulo, type MedidorDeAuditoria } from '../metrics/audit.metrics.js';

export interface DependenciasDoAuditService {
  readonly trilha: RepositorioDaTrilha;
  readonly checkpoints: RepositorioDeCheckpoint;
  readonly logger: Logger;
  /** Segredo que impede reverter o `subject_hint` por dicionário de e-mails. */
  readonly pepper: string;
  /** De quantos em quantos eventos a posição do topo é ancorada no PostgreSQL. */
  readonly checkpointACada: number;
  readonly medidor?: MedidorDeAuditoria;
}

/** Nomes de chave sensível encontrados em `metadata`. */
function chavesProibidas(metadata: Readonly<Record<string, ValorDeMetadata>>): string[] {
  return Object.keys(metadata).filter((chave) => {
    const normalizada = chave.toLowerCase();
    return FRAGMENTOS_PROIBIDOS_EM_METADATA.some((fragmento) => normalizada.includes(fragmento));
  });
}

function traceAtual(): string | null {
  const contexto = trace.getActiveSpan()?.spanContext();
  return contexto !== undefined && isSpanContextValid(contexto) ? contexto.traceId : null;
}

export function criarAuditService(deps: DependenciasDoAuditService): RegistradorDeAuditoria {
  const medidor = deps.medidor ?? medidorDeAuditoriaNulo();

  function derivarPista(email: string): string {
    return createHash('sha256')
      .update(`${email.trim().toLowerCase()}:${deps.pepper}`, 'utf8')
      .digest('hex');
  }

  /** Completa o evento com o que só o serviço sabe: instante, id, origem e correlação. */
  function normalizar(evento: EventoDeAuditoria): EventoParaAnexar {
    const metadata = evento.metadata ?? {};
    const proibidas = chavesProibidas(metadata);
    if (proibidas.length > 0) throw new ErroDeAuditoria('metadata-proibida', proibidas);

    const contexto = contextoDeRequisicao();
    const ip = evento.actor.ip ?? contexto?.ip;
    const userAgent = evento.actor.userAgent ?? contexto?.userAgent;

    return {
      eventId: uuidv7(),
      type: evento.type,
      occurredAt: new Date(),
      actor: {
        id: evento.actor.id,
        type: evento.actor.type,
        ...(ip === undefined ? {} : { ip }),
        ...(userAgent === undefined ? {} : { userAgent }),
      },
      target: evento.target ?? null,
      outcome: evento.outcome,
      reason: evento.reason ?? null,
      subjectHint: evento.subjectEmail === undefined ? null : derivarPista(evento.subjectEmail),
      metadata,
      requestId: contexto?.requestId ?? null,
      traceId: traceAtual(),
    };
  }

  async function ancorar(seq: number, hash: string): Promise<void> {
    if (seq % deps.checkpointACada !== 0) return;
    try {
      await deps.checkpoints.gravar(seq, hash);
      medidor.registrarCheckpoint(seq);
    } catch (erro) {
      // O evento já está na trilha; sem âncora, só encolhe a janela protegida contra
      // truncamento. Avisar é suficiente — desfazer não é possível nem desejável.
      deps.logger.warn({ err: erro, seq }, 'falha ao ancorar o topo da trilha');
    }
  }

  return {
    async registrar(evento: EventoDeAuditoria): Promise<void> {
      const inicio = process.hrtime.bigint();
      try {
        const base = normalizar(evento);
        const { evento: persistido, tentativas } = await deps.trilha.anexar(base, (seq, prevHash) =>
          calcularHashDoElo(seq, prevHash, base),
        );

        medidor.contarEvento(persistido.type, persistido.outcome);
        medidor.contarConflito(tentativas - 1);
        medidor.observarEscrita(Number(process.hrtime.bigint() - inicio) / 1e9);

        await ancorar(persistido.seq, persistido.hash);
      } catch (erro) {
        if (erro instanceof ErroDeAuditoria && erro.codigo === 'metadata-proibida') {
          // Só os nomes das chaves: logar o evento inteiro publicaria exatamente o valor
          // que a recusa existe para manter fora da trilha.
          deps.logger.error(
            { tipo: evento.type, chaves: erro.chaves },
            'evento de auditoria recusado: metadata com chave sensível',
          );
          medidor.contarFalha('metadata-proibida');
          return;
        }

        // Fallback: o evento passou na validação, então pode ir inteiro para o log. É o
        // rastro que resta enquanto a trilha estiver fora.
        deps.logger.error(
          { err: erro, evento_de_auditoria: evento },
          'falha ao gravar evento de auditoria',
        );
        medidor.contarFalha('escrita');
      }
    },
  };
}
