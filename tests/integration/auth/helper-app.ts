/**
 * Monta um app Fastify com as rotas de autenticação, para os testes de integração.
 *
 * Bancos reais (usuário/papéis no PostgreSQL, denylist no Mongo) e um JWKS real com uma
 * chave active recém-gerada. O refresh token usa o stub — a persistência dele é de outro módulo.
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
} from '../../../src/modules/auth/index.js';
import {
  registrarRotasDeRefresh,
  criarRefreshTokenService,
  criarRepositorioDeRefreshToken,
  type RefreshTokenService,
} from '../../../src/modules/refresh-token/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
// TTLs largos: nada expira nos testes de integração. `grace` 0 torna a detecção de reuso
// imediata e determinística — a janela de graça é coberta por teste unitário com relógio controlado.
const REFRESH_TTL_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_ABSOLUTO_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_GRACE_MS = 0;

export interface AppDeAuth {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly refreshTokenService: RefreshTokenService;
}

export async function montarAppDeAuth(opcoes: { pool: Pool; banco: Db }): Promise<AppDeAuth> {
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

  // JWKS com uma chave active real, para assinar e verificar de verdade.
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

  // Refresh token persistente real no lugar do stub em memória.
  const refreshTokenService = criarRefreshTokenService({
    repo: criarRepositorioDeRefreshToken(opcoes.banco),
    usuarios: repoAuth,
    tokenService,
    ttlIdleMs: REFRESH_TTL_IDLE_MS,
    ttlAbsolutoMs: REFRESH_TTL_ABSOLUTO_MS,
    graceMs: REFRESH_GRACE_MS,
  });

  const authService = criarAuthService({
    repo: repoAuth,
    servicoDeSenha,
    tokenService,
    refreshToken: refreshTokenService,
    denylist,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  });

  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeRefresh(app, { refreshTokenService });
  await app.ready();
  return { app, servicoDeSenha, refreshTokenService };
}
