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
import type { ServicoDeProntidao } from './modules/health/services/prontidao.service.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

/**
 * Quantos hops de proxy confiar ao derivar `request.ip` do `X-Forwarded-For`.
 *
 * `true` confiaria na cadeia inteira, e a ponta esquerda do XFF é escrita pelo cliente:
 * qualquer um forjaria o próprio IP e escaparia do rate limit por IP que a SPEC 016 vai
 * construir em cima disso. Confiando em 1 hop, vale a entrada que o próprio proxy
 * acrescentou, que o cliente não controla.
 *
 * Fora de produção não existe proxy na frente, então confiar em qualquer header é só
 * abrir spoofing sem ganho nenhum.
 *
 * ponytail: 1 hop é o desenho do Render. Se entrar CDN ou outro proxy na frente,
 * este número sobe junto — ou vira lista de faixas confiáveis.
 */
export function hopsDeProxyConfiaveis(env: Env): number | false {
  return env.NODE_ENV === 'production' ? 1 : false;
}

export interface DependenciasDoApp {
  /**
   * Serviço de prontidão. Opcional porque testes que só exercitam liveness ou o handler
   * de erro não precisam de banco — nesse caso o readiness responde 503, que é a
   * resposta honesta para uma instância sem dependências configuradas.
   */
  readonly prontidao?: ServicoDeProntidao;
}

/** Prontidão degenerada: usada quando o app sobe sem dependências injetadas. */
function prontidaoIndisponivel(): ServicoDeProntidao {
  return {
    consultar: () => Promise.resolve({ pronto: false, encerrando: false, dependencias: [] }),
    marcarEncerrando: () => undefined,
  };
}

export async function construirApp(
  env: Env,
  dependencias: DependenciasDoApp = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: hopsDeProxyConfiaveis(env),
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

  // A UI (e o /docs/json que vem com ela) publica a superfície inteira da API sem
  // autenticação. Hoje isso é só /health/live; conforme 001 e 012 entrarem, vira o mapa
  // dos endpoints de autenticação e OAuth entregue de graça a quem varre a internet.
  // O @fastify/swagger acima continua registrado em todo ambiente: ele só constrói o
  // documento em memória, sem expor rota — é o que alimenta app.swagger() e o teste de
  // contrato.
  if (env.NODE_ENV !== 'production') {
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

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

  registrarRotasDeHealth(app, {
    prontidao: dependencias.prontidao ?? prontidaoIndisponivel(),
  });

  await app.ready();
  return app;
}
