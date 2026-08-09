/**
 * Responsabilidade: a forma de um evento de segurança — o juízo derivado, distinto do fato
 * bruto que a trilha guarda.
 * Consumido por: as regras, o detector, o repositório e a borda de leitura.
 * Regras:
 *  - O sujeito é **sempre** uma pista anonimizada. O campo se chama `pista` e não `id` de
 *    propósito: quem for preencher com e-mail vai perceber que está no lugar errado.
 *  - Nada aqui conhece Mongo, Fastify ou Zod.
 */
import type { Regra, Severidade, TipoDeSujeito } from '../constants/regras.js';

export interface SujeitoDeSeguranca {
  readonly tipo: TipoDeSujeito;
  /** `sha256(identificador + pepper)` — a mesma derivação que a trilha usa. */
  readonly pista: string;
}

/** O que uma regra devolve quando o limiar fecha. Ainda sem posição nem instante. */
export interface Deteccao {
  readonly regra: Regra;
  readonly severidade: Severidade;
  readonly sujeito: SujeitoDeSeguranca;
  readonly ocorrencias: number;
  readonly janelaMs: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** O evento como ele vive na coleção: com instantes e correlação. */
export interface EventoDeSeguranca extends Deteccao {
  readonly id: string;
  readonly primeiraEm: Date;
  readonly ultimaEm: Date;
  readonly detectadoEm: Date;
  readonly traceId: string | null;
}
