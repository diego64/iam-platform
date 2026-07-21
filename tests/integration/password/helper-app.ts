/**
 * Monta um app Fastify mínimo com as rotas de senha, para os testes de integração.
 *
 * Mistura deliberada: bancos REAIS para a persistência que a 009 possui (token de reset no
 * Mongo, histórico no PG) e FAKES para as portas de outras SPECs (usuário, sessões,
 * notificação, autenticação). É a fronteira decidida no `tasks.md` — T09–T12 contra fakes.
 *
 * O autenticador fake lê `x-test-user-id`: o `verificarAccessToken` da 001 ocupa esse
 * lugar quando existir.
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
import { registrarRotasDeSenha } from '../../../src/modules/password/index.js';
import { criarPasswordService } from '../../../src/modules/password/services/password.service.js';
import { criarRepositorioDeTokenDeReset } from '../../../src/modules/password/repositories/reset-token.repository.js';
import { criarRepositorioDeHistorico } from '../../../src/modules/password/repositories/password-history.repository.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import type { RepositorioDeUsuarioFake } from '../../mocks/senha.js';
import {
  criarCanalDeNotificacaoFake,
  criarRevogadorDeSessoesFake,
  type CanalDeNotificacaoFake,
  type RevogadorDeSessoesFake,
} from '../../mocks/senha.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface AppDeSenha {
  readonly app: FastifyInstance;
  readonly notificacao: CanalDeNotificacaoFake;
  readonly sessoes: RevogadorDeSessoesFake;
  /** Aguarda o trabalho de fundo do `forgot` (que roda depois da resposta 202). */
  aguardarTrabalho(): Promise<void>;
}

/**
 * Sobe o app. Custo de scrypt reduzido (N=2^14) para os testes não pagarem o de produção.
 */
export async function montarAppDeSenha(opcoes: {
  banco: Db;
  pool: Pool;
  usuarios: RepositorioDeUsuarioFake;
}): Promise<AppDeSenha> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register((await import('@fastify/swagger')).default, {
    openapi: { info: { title: 'teste', version: '0' } },
    transform: jsonSchemaTransform,
  });

  // Opt-in por rota: cada rota de senha declara seu próprio teto em `config.rateLimit`;
  // rotas sem essa config não são limitadas.
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

  const notificacao = criarCanalDeNotificacaoFake();
  const sessoes = criarRevogadorDeSessoesFake();

  const passwordService = criarPasswordService({
    servicoDeSenha: criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 }),
    usuarios: opcoes.usuarios,
    tokensDeReset: criarRepositorioDeTokenDeReset(opcoes.banco),
    historico: criarRepositorioDeHistorico(opcoes.pool),
    sessoes,
    notificacao,
    ttlResetMin: 30,
    historicoN: 3,
  });

  // Coleta os trabalhos de fundo do forgot para o teste poder aguardá-los antes de
  // asseverar o que eles produzem (token no Mongo, entrega na notificação).
  const trabalhos: Promise<void>[] = [];

  registrarRotasDeSenha(app, {
    passwordService,
    autenticar: (req) => {
      const id = req.headers['x-test-user-id'];
      return typeof id === 'string' && id !== '' ? id : null;
    },
    aoAgendarTrabalho: (trabalho) => trabalhos.push(trabalho),
  });

  await app.ready();
  return {
    app,
    notificacao,
    sessoes,
    aguardarTrabalho: async () => {
      await Promise.all(trabalhos.splice(0));
    },
  };
}
