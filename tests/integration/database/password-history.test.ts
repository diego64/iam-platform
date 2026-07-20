/**
 * Cobre a migração `0003_create_password_history.sql`: a DDL aplica em PG limpo, cria a
 * tabela e o índice, e o FK com `ON DELETE CASCADE` limpa o histórico junto com o usuário.
 *
 * A tabela `users` é criada aqui como pré-condição mínima (só `id`), porque a DDL real de
 * `users` pertence à 002 e o runner de migração (`scripts/migrate.ts`) ainda é stub — ver
 * a nota de dependência no resumo de PR. O que este teste valida é a DDL DESTA SPEC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';

const DDL = readFileSync(
  new URL('../../../src/database/migrations/0003_create_password_history.sql', import.meta.url),
  'utf8',
);

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });

  // Ambiente limpo e determinístico: derruba o que uma execução anterior deixou.
  await pool.query('DROP TABLE IF EXISTS password_history');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.query('CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid())');

  await pool.query(DDL);
});

afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS password_history');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.end();
});

describe('migração password_history', () => {
  it('cria a tabela com as colunas esperadas', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'password_history' ORDER BY column_name`,
    );
    const colunas = rows.map((r) => r.column_name);

    expect(colunas).toEqual(['created_at', 'id', 'password_hash', 'user_id']);
  });

  it('cria o índice por usuário e tempo', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'password_history'`,
    );

    expect(rows.map((r) => r.indexname)).toContain('idx_password_history_user');
  });

  it('aplica de novo sem erro (idempotente por IF NOT EXISTS)', async () => {
    await expect(pool.query(DDL)).resolves.toBeDefined();
  });

  it('apaga o histórico em cascata quando o usuário é removido', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    const userId = rows[0]?.id;
    await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [
      userId,
      'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    ]);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const { rows: restantes } = await pool.query(
      'SELECT 1 FROM password_history WHERE user_id = $1',
      [userId],
    );
    expect(restantes).toHaveLength(0);
  });
});
