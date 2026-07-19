/**
 * Cobre as factories de conexão: recebem a configuração por injeção (nunca importam
 * singleton) e aplicam o teto de timeout que faz um host errado falhar o boot.
 */
import { describe, expect, it } from 'vitest';
import {
  criarPoolPostgres,
  TIMEOUT_DE_CONEXAO_MS as TIMEOUT_PG,
} from '../../../src/database/postgres/connection.js';
import { TIMEOUT_DE_CONEXAO_MS as TIMEOUT_MONGO } from '../../../src/database/mongodb/connection.js';
import { carregarEnv, type Env } from '../../../src/config/env.js';

function envDeTeste(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    POSTGRES_URL: 'postgres://localhost:5432/iam',
    MONGODB_URL: 'mongodb://localhost:27017',
    ...sobrescritas,
  });
}

describe('criarPoolPostgres', () => {
  it('repassa connectionString e max vindos da configuração injetada', async () => {
    const env = envDeTeste({ POSTGRES_POOL_MAX: '25' });
    const pool = criarPoolPostgres(env);

    try {
      expect(pool.options.max).toBe(25);
      expect(pool.options.connectionString).toBe(env.POSTGRES_URL);
    } finally {
      await pool.end();
    }
  });

  it('aplica o teto de conexão para não pendurar o boot', async () => {
    const pool = criarPoolPostgres(envDeTeste());

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(TIMEOUT_PG);
      expect(TIMEOUT_PG).toBeLessThanOrEqual(5_000);
    } finally {
      await pool.end();
    }
  });

  it('usa o default de pool quando POSTGRES_POOL_MAX não é informado', async () => {
    const pool = criarPoolPostgres(envDeTeste());

    try {
      expect(pool.options.max).toBe(10);
    } finally {
      await pool.end();
    }
  });
});

describe('conectarMongo', () => {
  it('declara o mesmo teto de conexão do PostgreSQL', () => {
    expect(TIMEOUT_MONGO).toBe(TIMEOUT_PG);
    expect(TIMEOUT_MONGO).toBeLessThanOrEqual(5_000);
  });
});
