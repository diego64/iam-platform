/**
 * Monta um app com as rotas de auth e de notificações, para os testes de integração.
 *
 * Bancos reais: usuários e permissões no PostgreSQL, denylist e dispositivos no Mongo, JWKS
 * real. O login emite token com a claim `perm` de verdade, então o guard de
 * `notifications:send` é exercitado ponta a ponta.
 *
 * O transporte é injetável: é o que permite observar o que a plataforma **mandaria** sem
 * mandar nada, e simular um provedor fora do ar sem derrubar mais nada junto.
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
import { criarContadorNoMongo } from '../../../src/shared/rate-limit/mongo-store.js';
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
import { criarAuditService, criarRepositorioDaTrilha } from '../../../src/modules/audit/index.js';
import { criarRepositorioDeCheckpoint } from '../../../src/modules/audit/index.js';
import {
  criarNotificador,
  criarRegistradorComNotificacao,
  criarRepositorioDeDispositivos,
  criarResolvedorDeDestinatario,
  criarServicoDeNotificacao,
  registrarRotasDeNotificacoes,
  type TransportadorDeEmail,
} from '../../../src/modules/notifications/index.js';
import type { MensagemDeEmail } from '../../../src/modules/notifications/types/mensagem.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

export interface AppDeNotificacoes {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  /** O que a plataforma mandaria — o transporte guarda em vez de entregar. */
  readonly enviadas: MensagemDeEmail[];
}

export interface OpcoesDoAppDeNotificacoes {
  readonly pool: Pool;
  readonly banco: Db;
  readonly destinatariosDeOperacao?: readonly string[];
  /** Simula provedor fora do ar. */
  readonly transporteQuebrado?: boolean;
  readonly maxPorHora?: number;
}

export async function montarAppDeNotificacoes(
  opcoes: OpcoesDoAppDeNotificacoes,
): Promise<AppDeNotificacoes> {
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

  const enviadas: MensagemDeEmail[] = [];
  const transporte: TransportadorDeEmail = {
    enviar(mensagem) {
      if (opcoes.transporteQuebrado === true) {
        return Promise.resolve({ ok: false as const, causa: 'indisponivel' as const });
      }
      enviadas.push(mensagem);
      return Promise.resolve({ ok: true as const });
    },
  };

  const notificacoes = criarServicoDeNotificacao({
    transporte,
    destinatarios: criarResolvedorDeDestinatario({ pool: opcoes.pool }),
    teto: criarContadorNoMongo({ banco: opcoes.banco, timeoutMs: 500 }),
    maxPorHora: opcoes.maxPorHora ?? 50,
    logger,
  });

  const auditoria = criarRegistradorComNotificacao(
    criarAuditService({
      trilha: criarRepositorioDaTrilha(opcoes.banco, { maxTentativas: 5 }),
      checkpoints: criarRepositorioDeCheckpoint(opcoes.pool),
      logger,
      pepper: PEPPER,
      checkpointACada: 100,
    }),
    criarNotificador({
      notificacoes,
      dispositivos: criarRepositorioDeDispositivos({
        banco: opcoes.banco,
        ttlMs: 90 * 24 * 60 * 60 * 1000,
        pepper: PEPPER,
      }),
    }),
  );

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

  registrarRotasDeNotificacoes(app, {
    notificacoes,
    destinatarios: opcoes.destinatariosDeOperacao ?? [],
    transporte: 'log',
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });

  await app.ready();
  return { app, servicoDeSenha, enviadas };
}
