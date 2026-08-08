/**
 * Responsabilidade: a forma de um evento de auditoria, antes e depois de persistido.
 * Consumido por: a porta de registro, o serviço, o repositório e a borda de leitura.
 * Regras: tipos simples e imutáveis — nada aqui conhece Mongo, Fastify ou Zod.
 */
import type {
  MotivoDeEvento,
  ResultadoDeEvento,
  TipoDeAlvo,
  TipoDeAtor,
  TipoDeEvento,
} from '../constants/event-types.js';

/** Valor aceito em `metadata`: escalar ou lista de texto. Objeto aninhado não entra. */
export type ValorDeMetadata = string | number | boolean | readonly string[];

export interface AtorDoEvento {
  /** `null` quando a operação não tinha ninguém autenticado (login que falhou, por exemplo). */
  readonly id: string | null;
  readonly type: TipoDeAtor;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface AlvoDoEvento {
  readonly id: string;
  readonly type: TipoDeAlvo;
}

/** O evento como quem o emite o descreve — sem posição na cadeia, sem hash, sem instante. */
export interface EventoDeAuditoria {
  readonly type: TipoDeEvento;
  readonly actor: AtorDoEvento;
  readonly target?: AlvoDoEvento;
  readonly outcome: ResultadoDeEvento;
  readonly reason?: MotivoDeEvento;
  /**
   * Identificador derivado do sujeito quando não há `actor.id` — sha256 do e-mail com
   * pepper. Quem emite passa o e-mail em `subjectEmail`; o serviço é que deriva o hash,
   * para o e-mail nunca circular além da borda.
   */
  readonly subjectEmail?: string;
  readonly metadata?: Readonly<Record<string, ValorDeMetadata>>;
}

/** O evento como ele vive na trilha: com posição, instante, correlação e encadeamento. */
export interface EventoPersistido {
  readonly seq: number;
  readonly eventId: string;
  readonly type: TipoDeEvento;
  readonly occurredAt: Date;
  readonly actor: AtorDoEvento;
  readonly target: AlvoDoEvento | null;
  readonly outcome: ResultadoDeEvento;
  readonly reason: MotivoDeEvento | null;
  readonly subjectHint: string | null;
  readonly metadata: Readonly<Record<string, ValorDeMetadata>>;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

/** O topo da cadeia: última posição ocupada e o hash correspondente. */
export interface TopoDaCadeia {
  readonly seq: number;
  readonly hash: string;
}

/** `prev_hash` do primeiro evento. 64 zeros marcam a gênese sem caso especial no cálculo. */
export const HASH_DE_GENESE = '0'.repeat(64);
