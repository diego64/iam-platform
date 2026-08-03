/**
 * Monta um app Fastify com as rotas de auth e as rotas administrativas de chaves, para os
 * testes de integração.
 *
 * Bancos reais e um JWKS real: o login emite tokens com a claim `perm` de verdade, então os
 * guards que protegem a rotação são exercitados ponta a ponta. O serviço de rotação recebe a
 * janela de pré-publicação por parâmetro para o teste poder exercitar tanto a recusa por
 * chave recente quanto a promoção bem-sucedida sem esperar dez minutos.
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
  registrarRotasDeJwks,
  type RepositorioJwks,
} from '../../../src/modules/jwks/index.js';
import { criarKeyRotationService } from '../../../src/modules/jwks/services/key-rotation.service.js';
import { registrarRotasDeChaves } from '../../../src/modules/jwks/routes/keys-admin.routes.js';
import {
  registrarRotasDeAuth,
  criarAuthService,
  criarTokenService,
  criarRepositorioDeAutenticacao,
  criarRepositorioDeDenylist,
  criarVerificadorDeAccessToken,
} from '../../../src/modules/auth/index.js';
import { criarRefreshTokenFalso } from '../../mocks/refresh-token.js';
import { criarGuardsDeAutorizacao } from '../../../src/modules/rbac/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export interface AppDeChaves {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly repo: RepositorioJwks;
}

export async function montarAppDeChaves(opcoes: {
  pool: Pool;
  banco: Db;
  /** Janela de pré-publicação; zero deixa a promoção liberada de imediato. */
  prepublicacaoMinMs?: number;
  graceMs?: number;
}): Promise<AppDeChaves> {
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

  const logger = criarLogger({ nivel: 'fatal' });
  const repo = criarRepositorioJwks(opcoes.pool);
  await garantirChaveDeBootstrap({ repo, masterKey: MASTER, logger });

  const jwks = criarJwksService({ repo, masterKey: MASTER, cacheTtlMs: 0 });
  await jwks.iniciar();

  const rotacao = criarKeyRotationService({
    repo,
    masterKey: MASTER,
    logger,
    invalidarCache: () => {
      jwks.invalidar();
    },
    graceMs: opcoes.graceMs ?? 900_000,
    prepublicacaoMinMs: opcoes.prepublicacaoMinMs ?? 0,
    purgaAposMs: 24 * 60 * 60 * 1000,
  });

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
  const denylist = criarRepositorioDeDenylist(opcoes.banco);
  const tokenService = criarTokenService(jwks, {
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
    ttlSegundos: 900,
  });
  const authService = criarAuthService({
    repo: criarRepositorioDeAutenticacao(opcoes.pool),
    servicoDeSenha,
    tokenService,
    refreshToken: criarRefreshTokenFalso(),
    denylist,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  });

  // O endpoint público entra junto: é por ele que o teste observa o efeito da rotação no
  // conjunto que os consumidores enxergam.
  registrarRotasDeJwks(app, { jwks });
  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeChaves(app, {
    rotacao,
    repo,
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });
  await app.ready();
  return { app, servicoDeSenha, repo };
}
