/**
 * Monta um app com as rotas de auth, refresh e do painel administrativo, para os testes de
 * integração.
 *
 * Bancos reais: usuários, papéis e permissões no PostgreSQL, refresh e trilha no Mongo. O
 * login emite token com a claim `perm` de verdade, e o refresh token é o real — sem isso, a
 * revogação de sessão de terceiro não teria o que derrubar.
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
import { registrarExigenciaDeGuardAdmin } from '../../../src/plugins/exigir-guard-admin.js';
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
  criarRefreshTokenService,
  criarRepositorioDeRefreshToken,
} from '../../../src/modules/refresh-token/index.js';
import {
  criarGuardsDeAutorizacao,
  criarRepositorioDeAssociacao,
} from '../../../src/modules/rbac/index.js';
import {
  criarRepositorioDaTrilha,
  criarRepositorioDeCheckpoint,
  criarAuditService,
} from '../../../src/modules/audit/index.js';
import { criarRepositorioDeUsuario } from '../../../src/modules/users/index.js';
import { criarRepositorioDeClientes } from '../../../src/modules/api-clients/index.js';
import { ultimaTrocaEm } from '../../../src/modules/password/repositories/password-history.repository.js';
import {
  registrarRotasDeAdmin,
  criarAdminSessionsService,
  criarOverviewService,
  criarUserViewService,
} from '../../../src/modules/admin/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

export interface AppDeAdmin {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
}

export async function montarAppDeAdmin(opcoes: {
  pool: Pool;
  banco: Db;
  janelaDeCacheMs?: number;
}): Promise<AppDeAdmin> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registrarContextoDeRequisicao(app);
  registrarExigenciaDeGuardAdmin(app);

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
  const repoAuth = criarRepositorioDeAutenticacao(opcoes.pool);
  const repoUsuarios = criarRepositorioDeUsuario(opcoes.pool);
  const repoRefresh = criarRepositorioDeRefreshToken(opcoes.banco);
  const repoAssociacoes = criarRepositorioDeAssociacao(opcoes.pool);
  const trilha = criarRepositorioDaTrilha(opcoes.banco, { maxTentativas: 5 });

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
  const auditoria = criarAuditService({
    trilha,
    checkpoints: criarRepositorioDeCheckpoint(opcoes.pool),
    logger,
    pepper: PEPPER,
    checkpointACada: 100,
  });
  const refreshTokenService = criarRefreshTokenService({
    repo: repoRefresh,
    usuarios: repoAuth,
    tokenService,
    ttlIdleMs: 7 * 24 * 60 * 60 * 1000,
    ttlAbsolutoMs: 30 * 24 * 60 * 60 * 1000,
    graceMs: 10_000,
    auditoria,
  });

  registrarRotasDeAuth(app, {
    authService: criarAuthService({
      repo: repoAuth,
      servicoDeSenha,
      tokenService,
      refreshToken: refreshTokenService,
      denylist,
      auditoria,
    }),
    verificarAccessToken,
  });

  const usuarios = {
    contarPorStatus: async (): Promise<Record<'active' | 'blocked', number>> => {
      const [active, blocked] = await Promise.all([
        repoUsuarios.contar('active'),
        repoUsuarios.contar('blocked'),
      ]);
      return { active, blocked };
    },
    buscarPorId: async (id: string) => {
      const usuario = await repoUsuarios.buscarPorId(id);
      return usuario === null
        ? null
        : {
            id: usuario.id,
            email: usuario.email,
            status: usuario.status,
            criadoEm: usuario.criadoEm,
            atualizadoEm: usuario.atualizadoEm,
          };
    },
  };
  const sessoes = {
    listarDoUsuario: async (userId: string) => {
      const familias = await repoRefresh.familiasAtivasDoUsuario(userId);
      return familias.map((familia) => ({
        sessionId: familia.familyId,
        criadaEm: familia.criadaEm,
        expiraEm: familia.expiraEm,
      }));
    },
    contarAtivas: () => repoRefresh.contarFamiliasAtivas(),
  };
  const auditoriaDeLeitura = {
    contarPorTipoDesde: (tipo: string, desde: Date) => trilha.contarPorTipoDesde(tipo, desde),
    ultimosDoUsuario: async (userId: string, limite: number) => {
      const eventos = await trilha.ultimosDoUsuario(userId, limite);
      return eventos.map((evento) => ({
        seq: evento.seq,
        type: evento.type,
        occurredAt: evento.occurredAt,
        outcome: evento.outcome,
      }));
    },
  };
  const repoClientes = criarRepositorioDeClientes(opcoes.pool);

  registrarRotasDeAdmin(app, {
    overview: criarOverviewService({
      usuarios,
      sessoes,
      auditoria: auditoriaDeLeitura,
      clientes: {
        contarAtivos: async () => {
          const { total } = await repoClientes.listar({ status: 'active', limit: 1, offset: 0 });
          return total;
        },
      },
      chaves: {
        obter: async () => {
          const ativa = await repoJwks.obterAtiva();
          return ativa === null ? null : { kid: ativa.kid, criadaEm: ativa.criadaEm };
        },
      },
      janelaDeCacheMs: opcoes.janelaDeCacheMs ?? 0,
    }),
    ficha: criarUserViewService({
      usuarios,
      autorizacao: {
        papeisDoUsuario: async (userId: string) => {
          const papeis = await repoAssociacoes.papeisDoUsuario(userId);
          return papeis.map((papel) => ({ id: papel.id, name: papel.name, isSystem: false }));
        },
        permissoesEfetivas: (userId: string) => repoAuth.permissoesEfetivas(userId),
      },
      sessoes,
      auditoria: auditoriaDeLeitura,
      senha: { alteradaEm: (userId: string) => ultimaTrocaEm(opcoes.pool, userId) },
      limiteDeEventos: 10,
    }),
    sessoes: criarAdminSessionsService({
      usuarios,
      sessoes,
      revogador: {
        revogarUma: (userId: string, sessionId: string) =>
          repoRefresh.revogarFamiliaDoUsuario(userId, sessionId),
        revogarTodas: (userId: string) => repoRefresh.revogarDoUsuario(userId),
      },
      auditoria,
    }),
    guards: criarGuardsDeAutorizacao(),
    verificarAccessToken,
  });

  await app.ready();
  return { app, servicoDeSenha };
}
