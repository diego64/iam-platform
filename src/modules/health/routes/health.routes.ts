/**
 * Responsabilidade: registrar as rotas de health.
 *
 * Liveness e readiness respondem perguntas diferentes e por isso não compartilham
 * implementação — ver o contraste em specs/017-health/api.md.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { responderLive, responderReady } from '../controllers/health.controller.js';
import { respostaLiveSchema } from '../schemas/health.schema.js';
import type { ServicoDeProntidao } from '../services/prontidao.service.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDeHealth {
  readonly prontidao: ServicoDeProntidao;
}

export function registrarRotasDeHealth(
  app: FastifyInstance,
  dependencias: DependenciasDeHealth,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();

  tipado.get(
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

  // Sem schema de resposta declarado: o corpo varia entre 200 e problem+json, e
  // declarar só o 200 faria o serializer do Zod podar os campos do erro justamente
  // quando eles são a informação útil.
  tipado.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description:
          'Verifica PostgreSQL e MongoDB. Diferente de /health/live, que só indica que o processo está vivo.',
      },
    },
    async (_requisicao, resposta) => {
      const { status, corpo } = await responderReady(dependencias.prontidao);

      if (status === 503) {
        // Sonda que recebe erro sem corpo não sabe o que reportar; o problem+json
        // carrega qual dependência caiu.
        await resposta.status(503).type(TIPO_PROBLEM_JSON).send(corpo);
        return;
      }

      await resposta.status(200).send(corpo);
    },
  );
}
