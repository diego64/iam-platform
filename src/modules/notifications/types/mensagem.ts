/**
 * Responsabilidade: a forma de uma mensagem pronta para entrega, e dos dados que os
 * templates recebem.
 * Consumido por: os templates, o serviço e os transportes.
 * Regras:
 *  - Nada aqui conhece Fastify, Mongo, PostgreSQL ou o provedor de e-mail.
 *  - `assunto` é sempre literal do catálogo. O tipo não impede uma interpolação, mas o
 *    teste de template impede — e o comentário diz por quê: assunto montado com dado de
 *    requisição é injeção de cabeçalho esperando acontecer.
 */
import type { TipoDeNotificacao } from '../constants/tipos.js';

export interface MensagemDeEmail {
  readonly para: readonly string[];
  readonly assunto: string;
  /** A versão de verdade. O HTML é o mesmo conteúdo em parágrafos. */
  readonly texto: string;
  readonly html: string;
}

/** O que o template produz, antes de saber para quem vai. */
export interface CorpoDeMensagem {
  readonly assunto: string;
  readonly texto: string;
  readonly html: string;
}

/** Origem da requisição, como ela aparece no corpo de um aviso ao dono da conta. */
export interface OrigemDoAcesso {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly quando: Date;
}

/** O que o serviço precisa saber para decidir e montar. */
export interface PedidoDeNotificacao {
  readonly tipo: TipoDeNotificacao;
  readonly para: readonly string[];
  readonly corpo: CorpoDeMensagem;
}
