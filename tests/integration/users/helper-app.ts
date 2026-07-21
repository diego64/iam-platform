/**
 * Monta um app Fastify mínimo com as rotas de usuário, para os testes de integração.
 *
 * Bancos REAIS para o que a 002 possui (tabela `users` no PG) e FAKES para as portas de
 * outras SPECs: o autorizador (001/003) e o revogador de sessões (001/006).
 *
 * O autorizador fake lê `x-test-admin`: ausente ⇒ 401; valor `no` ⇒ 403; qualquer outro
 * valor ⇒ admin autorizado com aquele id. O preHandler real da 001/003 ocupa esse lugar
 * quando existir.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { montarProblema } from '../../../src/shared/errors/problem-json.js';
import { registrarRotasDeUsuario } from '../../../src/modules/users/index.js';
import { criarRepositorioDeUsuario } from '../../../src/modules/users/repositories/user.repository.js';
import { criarUserService } from '../../../src/modules/users/services/user.service.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { autorizadorPorHeader, criarRevogadorDeSessoesFake } from '../../mocks/usuarios.js';
import type { RevogadorDeSessoesFake } from '../../mocks/usuarios.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface AppDeUsuario {
  readonly app: FastifyInstance;
  readonly sessoes: RevogadorDeSessoesFake;
}

/** Custo de scrypt reduzido (N=2^14) para os testes não pagarem o de produção. */
export async function montarAppDeUsuario(opcoes: { pool: Pool }): Promise<AppDeUsuario> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register((await import('@fastify/swagger')).default, {
    openapi: { info: { title: 'teste', version: '0' } },
    transform: jsonSchemaTransform,
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });

  app.setErrorHandler((erro: FastifyError, _req, resposta) => {
    if (hasZodFastifySchemaValidationErrors(erro)) {
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('validation-error', 'Requisição inválida', 400));
      return;
    }
    void resposta
      .status(erro.statusCode ?? 500)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('internal-error', 'Erro interno', 500));
  });

  const sessoes = criarRevogadorDeSessoesFake();
  const userService = criarUserService({
    repositorio: criarRepositorioDeUsuario(opcoes.pool),
    servicoDeSenha: criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 }),
    sessoes,
  });

  registrarRotasDeUsuario(app, { userService, autorizador: autorizadorPorHeader() });

  await app.ready();
  return { app, sessoes };
}
