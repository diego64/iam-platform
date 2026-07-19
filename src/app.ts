/**
 * Responsabilidade: montar a instância do Fastify — plugins globais, hooks, módulos e tratamento de erros.
 * Depende de: config/*, plugins/*, modules/*\/routes.
 * Consumido por: server.ts e testes de integração (Supertest usa app sem listen).
 * Regras: registrar helmet, cors restrito, rate-limit global, swagger, serializerCompiler/validatorCompiler do Zod;
 *         handler global de erros converte AppError → RFC 7807; nunca vazar stack em produção.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { carregarEnv } from './config/env.js';

export async function construirApp(): Promise<FastifyInstance> {
  const env = carregarEnv();
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  // registrar plugins na ordem — helmet → cors → rate-limit → swagger → zod providers
  // registrar módulos — health, metrics, jwks, auth, users, roles, permissions...
  // setErrorHandler com RFC 7807 (shared/errors/problem-json.ts)

  return app;
}
