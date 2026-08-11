/**
 * Cobre o runner de migração contra um PostgreSQL real.
 *
 * As duas propriedades que importam num deploy: reaplicar não quebra nada (toda subida roda
 * `migrate` antes do servidor) e `--dry-run` não escreve. A segunda é a que dói se estiver
 * errada — o dry-run existe justamente para inspecionar produção sem alterá-la.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { listarMigrations, migrar } from '../../../src/database/migrate.js';
import { criarPoolPostgres } from '../../../src/database/postgres/connection.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

let pool: Pool;

/** As versões registradas como aplicadas, em ordem. */
async function aplicadas(): Promise<string[]> {
  const { rows } = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return rows.map((r) => r.version);
}

beforeAll(async () => {
  // O ambiente de integração precisa das mesmas variáveis que o runner lê de `process.env`.
  const env = envDeIntegracao();
  process.env['POSTGRES_URL'] = env.POSTGRES_URL;
  process.env['MONGODB_URL'] = env.MONGODB_URL;

  await migrar(false);
  pool = criarPoolPostgres(env);
});

afterAll(async () => {
  await pool.end();
});

describe('aplicação', () => {
  it('registra toda migração do repositório', async () => {
    expect(await aplicadas()).toEqual(listarMigrations());
  });

  it('cria a tabela de controle com a versão como chave', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'schema_migrations' ORDER BY column_name`,
    );

    expect(rows.map((r) => r.column_name)).toEqual(['applied_at', 'version']);
  });
});

describe('idempotência', () => {
  it('reaplicar não duplica registro nem falha', async () => {
    const antes = await aplicadas();

    // Toda subida roda o runner antes do servidor: a segunda execução é o caso normal, não
    // a exceção.
    await migrar(false);

    expect(await aplicadas()).toEqual(antes);
  });
});

describe('dry-run', () => {
  it('não escreve nada quando há migração pendente', async () => {
    const antes = await aplicadas();
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [antes[antes.length - 1]]);

    try {
      await migrar(true);

      // A versão removida continua fora: o dry-run listou a pendência sem aplicá-la.
      expect(await aplicadas()).not.toContain(antes[antes.length - 1]);
    } finally {
      // Devolve o registro sem reexecutar o SQL — o schema nunca foi desfeito.
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        antes[antes.length - 1],
      ]);
    }

    expect(await aplicadas()).toEqual(antes);
  });
});
