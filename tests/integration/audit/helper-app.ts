/**
 * Monta um app com as rotas de auth e de auditoria, para os testes de integração.
 *
 * Bancos reais: usuários e âncoras no PostgreSQL, trilha e denylist no Mongo, JWKS real. O
 * login emite token com a claim `perm` de verdade, então o guard de `audit:read` e
 * `audit:verify` é exercitado ponta a ponta.
 *
 * A trilha aceita um banco próprio, separado do resto: é o que permite derrubar só a
 * escrita de auditoria e observar o serviço seguir respondendo — sem derrubar junto a
 * denylist, que faria o teste medir outra coisa.
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
import { registrarContextoDeRequisicao } from '../../../src/plugins/request-context.js';
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
  registrarRotasDeAuditoria,
  criarAuditIntegrityService,
  criarAuditQueryService,
  criarAuditService,
  criarRepositorioDaTrilha,
  criarRepositorioDeCheckpoint,
  type RepositorioDaTrilha,
} from '../../../src/modules/audit/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

export interface AppDeAuditoria {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly trilha: RepositorioDaTrilha;
}

export interface OpcoesDoAppDeAuditoria {
  readonly pool: Pool;
  readonly banco: Db;
  /** Banco da trilha, quando diferente do principal — usado para simular a trilha fora. */
  readonly bancoDaTrilha?: Db;
  readonly checkpointACada?: number;
  readonly janelaMaxima?: number;
}

export async function montarAppDeAuditoria(
  opcoes: OpcoesDoAppDeAuditoria,
): Promise<AppDeAuditoria> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registrarContextoDeRequisicao(app);

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
  const jwks = criarJwksService({ repo: repoJwks, masterKey: MASTER, cacheTtlMs: 300_000 });
  await jwks.iniciar();

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
  const denylist = criarRepositorioDeDenylist(opcoes.banco);
  const tokenService = criarTokenService(jwks, {
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
    ttlSegundos: 900,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  });

  const trilha = criarRepositorioDaTrilha(opcoes.bancoDaTrilha ?? opcoes.banco, {
    maxTentativas: 5,
  });
  const checkpoints = criarRepositorioDeCheckpoint(opcoes.pool);
  const auditoria = criarAuditService({
    trilha,
    checkpoints,
    logger,
    pepper: PEPPER,
    checkpointACada: opcoes.checkpointACada ?? 100,
  });

  registrarRotasDeAuth(app, {
    authService: criarAuthService({
      repo: criarRepositorioDeAutenticacao(opcoes.pool),
      servicoDeSenha,
      tokenService,
      refreshToken: criarRefreshTokenFalso(),
      denylist,
      auditoria,
    }),
    verificarAccessToken,
  });
  registrarRotasDeAuditoria(app, {
    consulta: criarAuditQueryService(trilha),
    integridade: criarAuditIntegrityService({
      trilha,
      checkpoints,
      janelaMaxima: opcoes.janelaMaxima ?? 50_000,
    }),
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });

  await app.ready();
  return { app, servicoDeSenha, trilha };
}
