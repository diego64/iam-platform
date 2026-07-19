/**
 * Responsabilidade: registrar as rotas de health.
 * Escopo SPEC 021: apenas /health/live. O /health/ready, que checa PostgreSQL e MongoDB
 * e responde 503 em problem+json, pertence à SPEC 017.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { responderLive } from '../controllers/health.controller.js';
import { respostaLiveSchema } from '../schemas/health.schema.js';

export function registrarRotasDeHealth(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        response: { 200: respostaLiveSchema },
      },
    },
    () => responderLive(),
  );
}
