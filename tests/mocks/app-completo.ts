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
  /**
   * Dublê do serviço de chaves, **tipado como o serviço**.
   *
   * Sem a anotação, um `as unknown as JwksService` aceitava qualquer forma: o dublê estubava
   * `obterJwks` e `obterChaveDeAssinatura`, que não existem na interface, e deixava
   * `obterConjuntoPublico` — o que o controller chama — sem implementação. O resultado era
   * `GET /.well-known/jwks.json` respondendo 500 em todo teste que usa este app, sem que
   * nenhuma asserção reprovasse. Anotado, o compilador acusa o próximo descompasso.
   */
  const jwks: JwksService = {
    iniciar: () => Promise.resolve(),
    invalidar: vi.fn(),
    obterConjuntoDeVerificacao: () =>
      Promise.reject(new Error('dublê sem conjunto de verificação: use um app com chaves')),
    obterChaveAtiva: () =>
      Promise.reject(new Error('dublê sem chave ativa: use um app com chaves')),
    obterConjuntoPublico: () => Promise.resolve({ keys: [] }),
  };

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
