/**
 * Porta de autenticação da rota de troca de senha.
 *
 * A troca autenticada precisa do id do usuário logado, que viria do access token
 * verificado — mas a emissão e a verificação de token ainda não existem. Por isso a rota
 * recebe esta função por injeção: devolve o id quando a requisição está autenticada, ou
 * `null` para o controller responder 401. O concreto será um preHandler que verifica o
 * access token e popula o id; até lá, um fake nos testes cumpre o contrato.
 */
import type { FastifyRequest } from 'fastify';

export type AutenticarUsuario = (requisicao: FastifyRequest) => string | null;
