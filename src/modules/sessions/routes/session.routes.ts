/**
 * Responsabilidade: registrar as rotas de sessão (listar, encerrar uma, encerrar as demais)
 * com validação Zod, Bearer obrigatório, rate limit por conta e tags OpenAPI.
 * Regras: recebe o serviço e o verificador de token por injeção; não conhece banco. Toda rota
 * passa pelo verificador, que popula `request.usuario` (incluindo a `sid`).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeSessao,
  type DependenciasDoControllerDeSessao,
} from '../controllers/session.controller.js';
import type { VerificadorDeAccessToken } from '../../auth/index.js';
import {
  paramsSessao,
  respostaListagem,
  respostaRevogarOutras,
} from '../schemas/session.schema.js';
import { LIMITE_SESSOES } from '../hooks/session-rate-limit.js';

export interface DependenciasDasRotasDeSessao extends DependenciasDoControllerDeSessao {
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeSessoes(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeSessao,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeSessao({ sessionService: deps.sessionService });
  const seguranca = [{ BearerAuth: [] }];

  tipado.get(
    '/auth/sessions',
    {
      schema: {
        tags: ['auth'],
        summary: 'Lista as sessões ativas do usuário, marcando a atual',
        security: seguranca,
        response: { 200: respostaListagem },
      },
      preHandler: deps.verificarAccessToken,
      config: { rateLimit: LIMITE_SESSOES },
    },
    (requisicao, resposta) => controller.listar(requisicao, resposta),
  );

  tipado.delete(
    '/auth/sessions/:id',
    {
      schema: {
        tags: ['auth'],
        summary: 'Encerra uma sessão do próprio usuário',
        security: seguranca,
        params: paramsSessao,
      },
      preHandler: deps.verificarAccessToken,
      config: { rateLimit: LIMITE_SESSOES },
    },
    (requisicao, resposta) => controller.revogar(requisicao, resposta),
  );

  tipado.delete(
    '/auth/sessions',
    {
      schema: {
        tags: ['auth'],
        summary: 'Encerra todas as outras sessões, preservando a atual',
        security: seguranca,
        response: { 200: respostaRevogarOutras },
      },
      preHandler: deps.verificarAccessToken,
      config: { rateLimit: LIMITE_SESSOES },
    },
    (requisicao, resposta) => controller.revogarOutras(requisicao, resposta),
  );
}
