/**
 * Monta um app Fastify com as rotas de auth e as de clientes de API, para os testes de
 * integração.
 *
 * Bancos reais e um JWKS real: o login emite tokens com a claim `perm` de verdade, então a
 * autoridade dividida das rotas de cliente é exercitada ponta a ponta — inclusive o guard do
 * `PATCH`, que escolhe entre papel e permissão pelo conteúdo do corpo.
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
import { criarRefreshTokenFalso } from '../../mocks/refresh-token.js';
import { criarGuardsDeAutorizacao } from '../../../src/modules/rbac/index.js';
import {
  registrarRotasDeClientes,
  criarApiClientService,
  criarClientAuthService,
  criarCatalogoDeEscopos,
  criarRepositorioDeClientes,
  criarResolvedorDeEscopos,
  type ClientAuthService,
  type RepositorioDeClientes,
} from '../../../src/modules/api-clients/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export interface AppDeClientes {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly repo: RepositorioDeClientes;
  readonly autenticacaoDeCliente: ClientAuthService;
}

export async function montarAppDeClientes(opcoes: {
  pool: Pool;
  banco: Db;
  sobreposicaoPadraoMs?: number;
  throttleDeUsoMs?: number;
}): Promise<AppDeClientes> {
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
  const repoJwks = criarRepositorioJwks(opcoes.pool);
  await garantirChaveDeBootstrap({ repo: repoJwks, masterKey: MASTER, logger });
  const jwks = criarJwksService({
    repo: repoJwks,
    masterKey: MASTER,
    cacheTtlMs: 300_000,
  });
  await jwks.iniciar();

  // Custo baixo: a suíte exercita a lógica, não o fator de trabalho do scrypt.
  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
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

  const repo = criarRepositorioDeClientes(opcoes.pool);
  const sobreposicaoPadraoMs = opcoes.sobreposicaoPadraoMs ?? 86_400_000;
  const service = criarApiClientService({
    repo,
    escopos: criarResolvedorDeEscopos(criarCatalogoDeEscopos(opcoes.pool)),
    servicoDeSenha,
    logger,
    sobreposicaoPadraoMs,
  });
  const autenticacaoDeCliente = criarClientAuthService({
    repo,
    servicoDeSenha,
    logger,
    throttleDeUsoMs: opcoes.throttleDeUsoMs ?? 300_000,
  });

  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeClientes(app, {
    service,
    sobreposicaoPadraoMs,
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });
  await app.ready();
  return { app, servicoDeSenha, repo, autenticacaoDeCliente };
}
