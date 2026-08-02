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

  it('não usa TLS para host local', async () => {
    const pool = criarPoolPostgres(envDeTeste());
    try {
      expect(pool.options.ssl).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('para host do Render, liga TLS com verificação de certificado', async () => {
    const env = envDeTeste({
      POSTGRES_URL: 'postgres://dpg-abc.oregon-postgres.render.com:5432/iam',
    });
    const pool = criarPoolPostgres(env);
    try {
      expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });

  it('não liga TLS de Render para host que só contém render.com como substring', async () => {
    // Host de atacante que embute a string: o match por hostname não pode cair nessa.
    const env = envDeTeste({ POSTGRES_URL: 'postgres://render.com.atacante.example:5432/iam' });
    const pool = criarPoolPostgres(env);
    try {
      expect(pool.options.ssl).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('inclui o CA quando POSTGRES_CA_CERT é informado, sem desligar a verificação', async () => {
    const env = envDeTeste({
      POSTGRES_URL: 'postgres://dpg-abc.oregon-postgres.render.com:5432/iam',
      POSTGRES_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
    });
    const pool = criarPoolPostgres(env);
    try {
      expect(pool.options.ssl).toMatchObject({
        rejectUnauthorized: true,
        ca: env.POSTGRES_CA_CERT,
      });
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
