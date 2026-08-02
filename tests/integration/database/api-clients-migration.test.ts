/**
 * Cobre a migração 0007: os dois CHECK que o banco usa como última barreira, a FK que
 * impede apagar uma permissão ainda usada como escopo, os índices do caminho quente e o
 * seed idempotente das permissões de administração.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { aplicarClientes, limparClientes, recriarSchemaDeClientes } from '../api-clients/schema.js';

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';

let pool: Pool;

async function inserirCliente(
  campos: Partial<{
    clientId: string;
    name: string;
    grantTypes: string[];
    previousHash: string | null;
    previousExpira: Date | null;
    status: string;
  }> = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_clients
       (client_id, secret_hash, name, grant_types, previous_secret_hash,
        previous_secret_expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      campos.clientId ?? `cli_${Math.random().toString(36).slice(2, 12)}`,
      HASH,
      campos.name ?? `cliente-${Math.random().toString(36).slice(2, 10)}`,
      campos.grantTypes ?? ['client_credentials'],
      campos.previousHash ?? null,
      campos.previousExpira ?? null,
      campos.status ?? 'active',
    ],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchemaDeClientes(pool);
});

beforeEach(async () => {
  await limparClientes(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('migração 0007 — CHECK de grant_types', () => {
  it('aceita os três grants da plataforma', async () => {
    await expect(
      inserirCliente({ grantTypes: ['client_credentials', 'password', 'refresh_token'] }),
    ).resolves.toBeTypeOf('string');
  });

  it('recusa grant fora da lista', async () => {
    await expect(inserirCliente({ grantTypes: ['authorization_code'] })).rejects.toThrow();
  });

  it('recusa lista de grants vazia — cliente sem grant não serve para nada', async () => {
    await expect(inserirCliente({ grantTypes: [] })).rejects.toThrow();
  });
});

describe('migração 0007 — CHECK da sobreposição de segredo', () => {
  it('aceita os dois campos nulos (sem rotação em andamento)', async () => {
    await expect(inserirCliente()).resolves.toBeTypeOf('string');
  });

  it('aceita os dois campos preenchidos', async () => {
    await expect(
      inserirCliente({ previousHash: HASH, previousExpira: new Date(Date.now() + 3600_000) }),
    ).resolves.toBeTypeOf('string');
  });

  // Um hash sem data de morte seria segunda via de autenticação permanente e invisível.
  it('recusa hash anterior sem data de expiração', async () => {
    await expect(inserirCliente({ previousHash: HASH })).rejects.toThrow();
  });

  it('recusa data de expiração sem hash anterior', async () => {
    await expect(
      inserirCliente({ previousExpira: new Date(Date.now() + 3600_000) }),
    ).rejects.toThrow();
  });
});

describe('migração 0007 — escopos e a FK para permissions', () => {
  async function vincularEscopo(clienteId: string, permissao: string): Promise<void> {
    await pool.query(
      `INSERT INTO api_client_scopes (client_id, permission_id)
       SELECT $1, id FROM permissions WHERE name = $2`,
      [clienteId, permissao],
    );
  }

  it('vincula o cliente a uma permissão do catálogo', async () => {
    const cliente = await inserirCliente();
    await vincularEscopo(cliente, 'clients:read');

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_client_scopes WHERE client_id = $1',
      [cliente],
    );
    expect(rows[0]?.n).toBe(1);
  });

  // Apagar a permissão em cascata tiraria a autoridade do cliente em silêncio.
  it('impede apagar uma permissão que ainda é escopo de algum cliente', async () => {
    const cliente = await inserirCliente();
    await pool.query("INSERT INTO permissions (name) VALUES ('orders:read')");
    await vincularEscopo(cliente, 'orders:read');

    await expect(
      pool.query("DELETE FROM permissions WHERE name = 'orders:read'"),
    ).rejects.toThrow();
  });

  it('remove os escopos junto com o cliente (cascade do lado do cliente)', async () => {
    const cliente = await inserirCliente();
    await vincularEscopo(cliente, 'clients:read');

    await pool.query('DELETE FROM api_clients WHERE id = $1', [cliente]);

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_client_scopes',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('impede o mesmo escopo duas vezes no mesmo cliente (PK composta)', async () => {
    const cliente = await inserirCliente();
    await vincularEscopo(cliente, 'clients:read');

    await expect(vincularEscopo(cliente, 'clients:read')).rejects.toThrow();
  });
});

describe('migração 0007 — unicidade e índices', () => {
  it('impede dois clientes com o mesmo client_id', async () => {
    await inserirCliente({ clientId: 'cli_repetido' });
    await expect(inserirCliente({ clientId: 'cli_repetido' })).rejects.toThrow();
  });

  it('impede dois clientes com o mesmo nome', async () => {
    await inserirCliente({ name: 'faturamento' });
    await expect(inserirCliente({ name: 'faturamento' })).rejects.toThrow();
  });

  it('cria os índices do caminho quente', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('idx_api_clients_ativos', 'idx_api_client_scopes_client')
        ORDER BY indexname`,
    );
    expect(rows.map((l) => l.indexname)).toEqual([
      'idx_api_client_scopes_client',
      'idx_api_clients_ativos',
    ]);
  });

  it('recusa status fora do conjunto', async () => {
    await expect(inserirCliente({ status: 'suspenso' })).rejects.toThrow();
  });
});

describe('migração 0007 — seed de permissões', () => {
  it('semeia as três permissões vinculadas ao superadmin', async () => {
    const { rows } = await pool.query<{ name: string; is_system: boolean }>(
      `SELECT p.name, p.is_system FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'clients:%'
        ORDER BY p.name`,
    );
    expect(rows.map((l) => l.name)).toEqual(['clients:delete', 'clients:read', 'clients:write']);
    expect(rows.every((l) => l.is_system)).toBe(true);
  });

  // Conceder escopo é conceder privilégio: essas duas operações checam o papel, não uma
  // permissão delegável.
  it('não semeia permissão de criação nem de alteração de escopo', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM permissions
        WHERE name IN ('clients:create', 'clients:scopes')`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('reaplicar a migração não falha nem duplica permissão ou vínculo', async () => {
    await aplicarClientes(pool);
    await aplicarClientes(pool);

    const permissoes = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM permissions WHERE name LIKE 'clients:%'",
    );
    const vinculos = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'superadmin' AND p.name LIKE 'clients:%'`,
    );
    expect(permissoes.rows[0]?.n).toBe(3);
    expect(vinculos.rows[0]?.n).toBe(3);
  });
});
