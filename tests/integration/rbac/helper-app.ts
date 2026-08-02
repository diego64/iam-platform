/**
 * Monta um app Fastify com as rotas de auth e de RBAC, para os testes de integração.
 *
 * Bancos reais (usuários/papéis no PostgreSQL, denylist no Mongo) e um JWKS real. O login
 * emite tokens com a claim `perm` de verdade, então os guards do RBAC são exercitados
 * ponta a ponta: seed do usuário + papéis → login → chamada autorizada.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import { montarProblema } from '../../../src/shared/errors/problem-json.js';
import {
  criarServicoDeSenha,
  type ServicoDeSenha,
} from '../../../src/shared/crypto/password.service.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import {
  criarRepositorioJwks,
  criarJwksService,
  garantirChaveDeBootstrap,
} from '../../../src/modules/jwks/index.js';
import {
  registrarRotasDeAuth,
  criarAuthService,
  criarTokenService,
  criarRepositorioDeAutenticacao,
  criarRepositorioDeDenylist,
  criarVerificadorDeAccessToken,
  criarRefreshTokenStub,
} from '../../../src/modules/auth/index.js';
import {
  registrarRotasDeRbac,
  criarGuardsDeAutorizacao,
  criarRepositorioDePapel,
  criarRepositorioDePermissao,
  criarRepositorioDeAssociacao,
  criarRbacService,
  criarAssignmentService,
} from '../../../src/modules/rbac/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export interface AppDeRbac {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
}

export async function montarAppDeRbac(opcoes: { pool: Pool; banco: Db }): Promise<AppDeRbac> {
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

  const repoJwks = criarRepositorioJwks(opcoes.pool);
  await garantirChaveDeBootstrap({
    repo: repoJwks,
    masterKey: MASTER,
    logger: criarLogger({ nivel: 'fatal' }),
  });
  const jwks = criarJwksService({
    repo: repoJwks,
    masterKey: MASTER,
    cacheTtlMs: 300_000,
  });
  await jwks.iniciar();

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
  const denylist = criarRepositorioDeDenylist(opcoes.banco);
  const repoAuth = criarRepositorioDeAutenticacao(opcoes.pool);
  const tokenService = criarTokenService(jwks, {
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
    ttlSegundos: 900,
  });

  const authService = criarAuthService({
    repo: repoAuth,
    servicoDeSenha,
    tokenService,
    refreshToken: criarRefreshTokenStub(),
    denylist,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  });

  const rbacService = criarRbacService({
    papeis: criarRepositorioDePapel(opcoes.pool),
    permissoes: criarRepositorioDePermissao(opcoes.pool),
    associacoes: criarRepositorioDeAssociacao(opcoes.pool),
  });
  const assignmentService = criarAssignmentService({
    associacoes: criarRepositorioDeAssociacao(opcoes.pool),
  });

  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeRbac(app, {
    rbacService,
    assignmentService,
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });
  await app.ready();
  return { app, servicoDeSenha };
}
