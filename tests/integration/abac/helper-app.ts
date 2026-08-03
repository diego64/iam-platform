/**
 * Monta um app Fastify com auth + RBAC + ABAC, para os testes de integração.
 *
 * Bancos reais e JWKS real, no mesmo padrão do helper do RBAC: o login emite tokens com a
 * claim `perm` de verdade, então a cadeia inteira (autentica → autoriza grosso pelo RBAC →
 * decide por atributo no ABAC) é exercitada ponta a ponta.
 *
 * O `GET /users/:id` registrado aqui é o proving ground de posse: a mesma rota existe no
 * módulo de usuários sem o guard de política, e é aqui que ela ganha `exigirPolitica`. O
 * mount em produção (`construirApp`) segue adiado como gap conhecido do projeto, igual ao
 * dos módulos de autenticação, usuários e RBAC.
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
import {
  registrarRotasDeRbac,
  criarGuardsDeAutorizacao,
  criarRepositorioDePapel,
  criarRepositorioDePermissao,
  criarRepositorioDeAssociacao,
  criarRbacService,
  criarAssignmentService,
} from '../../../src/modules/rbac/index.js';
import {
  registrarRotasDeAbac,
  criarAbacService,
  criarMotorDePoliticas,
  criarGuardsDePolitica,
  criarRepositorioDePolitica,
  type MotorDePoliticas,
} from '../../../src/modules/abac/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';
/** Teto da leitura do proving ground, no formato que o `@fastify/rate-limit` espera. */
const LIMITE_DE_LEITURA = { max: 200, timeWindow: '1 minute' };
const EMISSOR = 'https://iam.example.com';
const AUDIENCIA = 'iam-clients';
const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export interface AppDeAbac {
  readonly app: FastifyInstance;
  readonly servicoDeSenha: ServicoDeSenha;
  /** Exposto para o teste de cache poder simular a escrita vinda de outro processo. */
  readonly motor: MotorDePoliticas;
}

export async function montarAppDeAbac(opcoes: {
  pool: Pool;
  banco: Db;
  /** TTL do cache do PDP; o teste de invalidação usa um valor alto para isolar a causa. */
  ttlDeCacheMs?: number;
}): Promise<AppDeAbac> {
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
    refreshToken: criarRefreshTokenFalso(),
    denylist,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: AUDIENCIA,
  });

  const guardsRbac = criarGuardsDeAutorizacao();
  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeRbac(app, {
    rbacService: criarRbacService({
      papeis: criarRepositorioDePapel(opcoes.pool),
      permissoes: criarRepositorioDePermissao(opcoes.pool),
      associacoes: criarRepositorioDeAssociacao(opcoes.pool),
    }),
    assignmentService: criarAssignmentService({
      associacoes: criarRepositorioDeAssociacao(opcoes.pool),
    }),
    guards: guardsRbac,
    verificarAccessToken,
  });

  const repoPoliticas = criarRepositorioDePolitica(opcoes.pool);
  const motor = criarMotorDePoliticas({
    politicas: repoPoliticas,
    ...(opcoes.ttlDeCacheMs === undefined ? {} : { ttlMs: opcoes.ttlDeCacheMs }),
  });
  registrarRotasDeAbac(app, {
    abacService: criarAbacService({ politicas: repoPoliticas, motor }),
    motor,
    guards: guardsRbac,
    verificarAccessToken,
  });

  // Proving ground de posse: leitura do próprio perfil. `owner_id` é o próprio id do
  // usuário, então a política `system-ownership` do seed governa este endpoint.
  const { exigirPolitica } = criarGuardsDePolitica({ motor });
  app.get(
    '/users/:id',
    {
      // O handler consulta o banco, então declara teto próprio: o plugin foi registrado com
      // `global: false`, e sem isto a rota ficaria sem limite nenhum. Teto folgado — aqui ele
      // existe para o fixture espelhar a rota real, não para ser exercitado pelos testes.
      config: { rateLimit: LIMITE_DE_LEITURA },
      preHandler: [
        verificarAccessToken,
        guardsRbac.exigirPermissao('users:read'),
        exigirPolitica('user', 'read', async (req) => {
          const { id } = req.params as { id: string };
          const { rows } = await opcoes.pool.query<{ id: string; email: string }>(
            'SELECT id, email FROM users WHERE id = $1',
            [id],
          );
          const usuario = rows[0];
          return usuario === undefined ? null : { owner_id: usuario.id, type: 'user' };
        }),
      ],
    },
    async (req, resp) => {
      const { id } = req.params as { id: string };
      const { rows } = await opcoes.pool.query<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE id = $1',
        [id],
      );
      return resp.status(200).send(rows[0]);
    },
  );

  await app.ready();
  return { app, servicoDeSenha, motor };
}
