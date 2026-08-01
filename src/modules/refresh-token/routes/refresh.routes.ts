/**
 * Responsabilidade: registrar `POST /auth/refresh` com validação Zod, rate limit e tags OpenAPI.
 * Regras: recebe o `RefreshTokenService` por injeção; não conhece banco. Rota pública — o
 * próprio refresh token é a credencial, então não passa pelo verificador de access token.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeRefresh,
  type DependenciasDoControllerDeRefresh,
} from '../controllers/refresh.controller.js';
import { refreshBody, respostaRefresh } from '../schemas/refresh.schema.js';
import { LIMITE_REFRESH } from '../hooks/refresh-rate-limit.js';

export type DependenciasDasRotasDeRefresh = DependenciasDoControllerDeRefresh;

export function registrarRotasDeRefresh(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeRefresh,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeRefresh({ refreshTokenService: deps.refreshTokenService });

  tipado.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotaciona o refresh token e emite um novo par de tokens',
        body: refreshBody,
        response: { 200: respostaRefresh },
      },
      config: { rateLimit: LIMITE_REFRESH },
    },
    (requisicao, resposta) => controller.rotacionar(requisicao, resposta),
  );
}
