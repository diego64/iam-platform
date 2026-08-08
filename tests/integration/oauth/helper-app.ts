/**
 * Monta um app Fastify com as rotas de clientes, de auth e de OAuth, para os testes de
 * integração.
 *
 * Bancos reais, JWKS real e refresh token real: o percurso do `password` grant grava um
 * documento de refresh de verdade, com vínculo de cliente, e o `refresh_token` grant o
 * rotaciona — que é onde o vínculo precisa ser exercitado ponta a ponta.
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
  type JwksService,
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
} from '../../../src/modules/refresh-token/index.js';
import { criarGuardsDeAutorizacao } from '../../../src/modules/rbac/index.js';
import {
  registrarRotasDeClientes,
  criarApiClientService,
  criarClientAuthService,
  criarCatalogoDeEscopos,
  criarRepositorioDeClientes,
  criarResolvedorDeEscopos,
} from '../../../src/modules/api-clients/index.js';
import { registrarRotasDeOAuth, criarOAuthService } from '../../../src/modules/oauth/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
export const EMISSOR = 'https://iam.example.com';
export const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export interface AppDeOAuth {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly jwks: JwksService;
}

export async function montarAppDeOAuth(opcoes: {
  pool: Pool;
  banco: Db;
  passwordGrantHabilitado?: boolean;
}): Promise<AppDeOAuth> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register((await import('@fastify/swagger')).default, {
    openapi: { info: { title: 'teste', version: '0' } },
    transform: jsonSchemaTransform,
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });

  // Tratador global em problem+json: é justamente o que as rotas de OAuth **não** devem usar,
  // e tê-lo aqui prova que o escopo encapsulado ganha do handler da instância-mãe.
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
  const jwks = criarJwksService({ repo: repoJwks, masterKey: MASTER, cacheTtlMs: 300_000 });
  await jwks.iniciar();

  // Custo baixo: a suíte exercita a lógica, não o fator de trabalho do scrypt.
  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
  const denylist = criarRepositorioDeDenylist(opcoes.banco);
  const tokenService = criarTokenService(jwks, {
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
    ttlSegundos: 900,
  });
  const repoAuth = criarRepositorioDeAutenticacao(opcoes.pool);
  const refreshTokenService = criarRefreshTokenService({
    repo: criarRepositorioDeRefreshToken(opcoes.banco),
    usuarios: repoAuth,
    tokenService,
    ttlIdleMs: 60_000,
    ttlAbsolutoMs: 3_600_000,
    graceMs: 0,
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

  const repoClientes = criarRepositorioDeClientes(opcoes.pool);
  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeRefresh(app, { refreshTokenService });
  registrarRotasDeClientes(app, {
    service: criarApiClientService({
      repo: repoClientes,
      escopos: criarResolvedorDeEscopos(criarCatalogoDeEscopos(opcoes.pool)),
      servicoDeSenha,
      logger,
      sobreposicaoPadraoMs: 86_400_000,
    }),
    sobreposicaoPadraoMs: 86_400_000,
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });
  await registrarRotasDeOAuth(app, {
    oauthService: criarOAuthService({
      clientAuth: criarClientAuthService({
        repo: repoClientes,
        servicoDeSenha,
        logger,
        throttleDeUsoMs: 0,
      }),
      tokenService,
      authService,
      refreshTokenService,
      passwordGrantHabilitado: opcoes.passwordGrantHabilitado ?? true,
    }),
  });

  await app.ready();
  return { app, servicoDeSenha, jwks };
}

/** Monta o corpo form-urlencoded que o endpoint de token exige. */
export function formulario(campos: Record<string, string>): string {
  return new URLSearchParams(campos).toString();
}

export const CABECALHO_FORMULARIO = {
  'content-type': 'application/x-www-form-urlencoded',
};

/** `Authorization: Basic` com o par percent-encoded, como manda a RFC 6749 §2.3.1. */
export function basic(clientId: string, secret: string): string {
  const par = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`;
  return `Basic ${Buffer.from(par, 'utf8').toString('base64')}`;
}
