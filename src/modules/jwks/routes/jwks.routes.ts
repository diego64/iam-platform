/**
 * Responsabilidade: registrar `GET /.well-known/jwks.json`, o endpoint público que os
 * consumidores raspam para validar os tokens offline.
 * Regras: recebe o serviço de chaves por injeção; rota sem autenticação (`security: []`).
 * `Cache-Control: public, max-age=300` — a chave nova entra no conjunto bem antes de assinar,
 * então cachear por 5 min é seguro e tira carga do endpoint.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeJwks,
  type DependenciasDoControllerJwks,
} from '../controllers/jwks.controller.js';
import { jwksResponseSchema } from '../schemas/jwks.schema.js';

export function registrarRotasDeJwks(
  app: FastifyInstance,
  deps: DependenciasDoControllerJwks,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeJwks(deps);

  tipado.get(
    '/.well-known/jwks.json',
    {
      schema: {
        tags: ['jwks'],
        summary: 'Conjunto de chaves públicas de verificação (JWK Set)',
        security: [],
        response: { 200: jwksResponseSchema },
      },
    },
    async (_requisicao, resposta) => {
      const corpo = await controller.publicar();
      await resposta.header('cache-control', 'public, max-age=300').send(corpo);
    },
  );
}
