/**
 * Responsabilidade: montar a instância do Fastify — provider do Zod, Swagger, handler
 * global de erros e registro dos módulos.
 * Consumido por: server.ts e testes de integração (Supertest usa o app sem listen).
 * Regras: recebe a configuração por injeção; nunca lê process.env nem abre socket.
 *
 * Escopo SPEC 021: helmet, cors restrito e rate limit global entram nas SPECs 024 e 016.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { montarProblema } from './shared/errors/problem-json.js';
import { registrarRotasDeHealth } from './modules/health/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export async function construirApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Confia no proxy do Render para obter o IP real do cliente — insumo do rate
    // limit por IP da SPEC 016.
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'iam-platform', version: '0.1.0' },
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  /**
   * Handler global: toda saída de erro sai como problem+json.
   * Em erro não previsto, `detail` é fixo — stack, SQL e mensagem do driver ficam
   * apenas no log, nunca na resposta.
   */
  app.setErrorHandler((erro: FastifyError, requisicao, resposta) => {
    if (hasZodFastifySchemaValidationErrors(erro)) {
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('validation-error', 'Requisição inválida', 400));
      return;
    }

    const status = erro.statusCode ?? 500;

    if (status >= 500) {
      requisicao.log.error({ err: erro }, 'erro não tratado');
      void resposta
        .status(500)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('internal-error', 'Erro interno', 500));
      return;
    }

    void resposta
      .status(status)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('request-error', erro.message, status));
  });

  // O 404 do Fastify não passa pelo setErrorHandler — sem este handler, rota
  // inexistente escaparia do formato problem+json exigido pelo CLAUDE.md.
  app.setNotFoundHandler((_requisicao, resposta) => {
    void resposta
      .status(404)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('not-found', 'Recurso não encontrado', 404));
  });

  registrarRotasDeHealth(app);

  await app.ready();
  return app;
}
