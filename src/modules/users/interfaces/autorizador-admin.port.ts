/**
 * Porta de autorização das rotas administrativas de usuário.
 *
 * A 002 precede a 001 (middleware de bearer) e a 003 (guard de papel) no roadmap: nenhuma
 * das duas capacidades existe ainda. A rota recebe este autorizador por injeção — devolve
 * o id do admin quando a requisição está autenticada E tem papel de administrador, ou o
 * motivo da recusa para o controller escolher entre 401 (sem token) e 403 (sem permissão).
 * O concreto será um preHandler que verifica o access token e checa o papel `admin`; até
 * lá, um fake nos testes cumpre o contrato.
 */
import type { FastifyRequest } from 'fastify';

export type MotivoDeRecusa = 'sem-token' | 'sem-permissao';

export type ResultadoDeAutorizacao =
  | { readonly ok: true; readonly adminId: string }
  | { readonly ok: false; readonly motivo: MotivoDeRecusa };

export type AutorizadorAdmin = (requisicao: FastifyRequest) => ResultadoDeAutorizacao;
