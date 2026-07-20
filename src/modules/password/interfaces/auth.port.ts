/**
 * Porta de autenticação da rota de troca de senha.
 *
 * A troca autenticada precisa do id do usuário logado, que vem do access token (SPEC 001).
 * Como a 001 ainda não existe, a rota recebe esta função por injeção: devolve o id quando
 * a requisição está autenticada, ou `null` para o controller responder 401. O concreto é
 * o `verificarAccessToken` da 001 (um preHandler que popula o id); até lá, um fake nos
 * testes cumpre o contrato.
 */
import type { FastifyRequest } from 'fastify';

export type AutenticarUsuario = (requisicao: FastifyRequest) => string | null;
