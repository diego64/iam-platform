/**
 * Sobe o app real com todos os módulos montados, sem banco.
 *
 * O composition root é fiação: repositórios apenas guardam a conexão que recebem, e nada
 * consulta PostgreSQL ou Mongo durante a construção. Conexões falsas bastam, portanto,
 * para qualquer teste que pergunte **o que o processo serve** em vez de o que cada rota
 * responde — a montagem e o contrato de superfície.
 */
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import { construirApp } from '../../src/app.js';
import { construirModulos } from '../../src/bootstrap/composicao.js';
import { carregarEnv, type Env } from '../../src/config/env.js';
import { criarLogger } from '../../src/shared/logger/index.js';
import type { JwksService, RepositorioJwks } from '../../src/modules/jwks/index.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

export function envCompleta(sobrescritas: NodeJS.ProcessEnv = {}): Env {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    // Sem o segredo mestre não existe serviço de rotação, e as rotas de /admin/keys não sobem.
    MASTER_KEY: MASTER,
    ...sobrescritas,
  });
}

export async function montarAppCompleto(env: Env = envCompleta()): Promise<FastifyInstance> {
  const jwks = {
    iniciar: vi.fn(),
    invalidar: vi.fn(),
    obterConjuntoDeVerificacao: vi.fn(),
    obterChaveDeAssinatura: vi.fn(),
    obterJwks: vi.fn(() => Promise.resolve({ keys: [] })),
  } as unknown as JwksService;

  const modulos = construirModulos({
    env,
    pool: { query: vi.fn() } as unknown as Pool,
    banco: { collection: vi.fn(() => ({})) } as unknown as Db,
    jwks,
    repoJwks: {} as RepositorioJwks,
    logger: criarLogger({ nivel: 'fatal' }),
  });

  // Exportador de mentira só para `GET /metrics` existir: a rota é condicional à
  // telemetria, e sem ela a superfície servida ficaria menor que a documentada por um
  // motivo que não tem nada a ver com montagem de módulo.
  const telemetria = {
    ativa: true,
    metricas: true,
    traces: false,
    exportadorPrometheus: {} as never,
    encerrar: () => Promise.resolve(),
  };

  return construirApp(env, { jwks, modulos, telemetria });
}
