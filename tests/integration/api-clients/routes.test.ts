/**
 * Cobre as rotas de clientes ponta a ponta contra bancos reais: o segredo que aparece uma
 * vez só, a autoridade dividida por campo no PATCH, os erros de escopo e a varredura de que
 * nenhuma leitura devolve material de credencial.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarClientes, limparClientes } from './schema.js';
import { montarAppDeClientes } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-clientes@iam.local';
const OPERADOR = 'operador-clientes@iam.local';
const LEITOR = 'leitor-clientes@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let servicoDeSenha: Awaited<ReturnType<typeof montarAppDeClientes>>['servicoDeSenha'];
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.13.0.${String(ip % 250)}`;
}

async function logar(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email, senha: SENHA },
  });
  return res.json<{ access_token: string }>().access_token;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function criarUsuario(email: string): Promise<void> {
  const hash = await servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
}

async function criarPapelComPerms(name: string, perms: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO roles (name) VALUES ($1) RETURNING id',
    [name],
  );
  const roleId = rows[0]?.id ?? '';
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE name = ANY($2)`,
    [roleId, perms],
  );
  return roleId;
}

async function atribuirPapel(email: string, roleId: string): Promise<void> {
  await pool.query(
    'INSERT INTO user_roles (user_id, role_id) SELECT id, $2 FROM users WHERE email = $1',
    [email, roleId],
  );
}

/** Cria um cliente pela API e devolve o corpo da resposta. */
async function novoCliente(
  token: string,
  corpo: Record<string, unknown> = {},
): Promise<{ id: string; client_id: string; client_secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clients',
    headers: bearer(token),
    payload: { name: `c-${String(Math.random()).slice(2, 10)}`, scopes: ['orders:read'], ...corpo },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  await aplicarClientes(pool);
  // Escopos de negócio que os testes concedem; o catálogo é a tabela de permissões.
  await pool.query(
    `INSERT INTO permissions (name) VALUES ('orders:read'), ('orders:write')
     ON CONFLICT (name) DO NOTHING`,
  );

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  ({ app, servicoDeSenha } = await montarAppDeClientes({ pool, banco }));

  await criarUsuario(ADMIN);
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM roles WHERE name = 'superadmin'",
  );
  await atribuirPapel(ADMIN, rows[0]?.id ?? '');

  await criarUsuario(OPERADOR);
  await atribuirPapel(
    OPERADOR,
    await criarPapelComPerms('clientes-operador', [
      'clients:read',
      'clients:write',
      'clients:delete',
    ]),
  );

  await criarUsuario(LEITOR);
  await atribuirPapel(LEITOR, await criarPapelComPerms('clientes-leitor', ['clients:read']));
});

beforeEach(async () => {
  await limparClientes(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('POST /clients', () => {
  it('cria e devolve o segredo em claro uma única vez', async () => {
    const token = await logar(ADMIN);

    const criado = await novoCliente(token);

    expect(criado.client_id.startsWith('cli_')).toBe(true);
    expect(criado.client_secret).toHaveLength(43);

    const lido = await app.inject({
      method: 'GET',
      url: `/clients/${criado.id}`,
      headers: bearer(token),
    });
    expect(lido.body).not.toContain(criado.client_secret);
    expect(lido.body).not.toContain('client_secret');
  });

  // Conceder escopo é conceder privilégio: quem pudesse fazê-lo criaria um cliente com
  // autoridade que ele próprio não tem e usaria o token dele.
  it('nega quem tem clients:write mas não é superadmin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(await logar(OPERADOR)),
      payload: { name: 'tentativa', scopes: ['orders:read'] },
    });

    expect(res.statusCode).toBe(403);
  });

  it('recusa escopo que não existe no catálogo, dizendo qual faltou', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(await logar(ADMIN)),
      payload: { name: 'escopo-invalido', scopes: ['orders:read', 'nao:existe'] },
    });

    expect(res.statusCode).toBe(422);
    const corpo = res.json<{ type: string; detail: string }>();
    expect(corpo.type).toContain('unknown-scope');
    expect(corpo.detail).toContain('nao:existe');
    expect(corpo.detail).not.toContain('orders:read');
  });

  it('recusa o curinga já na validação de formato', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(await logar(ADMIN)),
      payload: { name: 'com-curinga', scopes: ['*'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('recusa nome já em uso', async () => {
    const token = await logar(ADMIN);
    await novoCliente(token, { name: 'duplicado' });

    const res = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(token),
      payload: { name: 'duplicado', scopes: ['orders:read'] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('client-name-already-exists');
  });

  it('recusa campo extra e tentativa de forjar o identificador', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: bearer(await logar(ADMIN)),
      payload: { name: 'forjado', scopes: ['orders:read'], client_id: 'cli_forjado' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /clients', () => {
  it('lista para quem tem clients:read', async () => {
    await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'GET',
      url: '/clients',
      headers: bearer(await logar(LEITOR)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(1);
  });

  it('nenhuma listagem carrega material de credencial', async () => {
    await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'GET',
      url: '/clients',
      headers: bearer(await logar(LEITOR)),
    });

    for (const proibido of ['client_secret', 'secret_hash', 'previous_secret_hash']) {
      expect(res.body).not.toContain(proibido);
    }
  });

  it('nega sem token e sem permissão', async () => {
    expect((await app.inject({ method: 'GET', url: '/clients' })).statusCode).toBe(401);
  });
});

describe('PATCH /clients/:id — autoridade por campo', () => {
  it('operador altera campo operacional', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(await logar(OPERADOR)),
      payload: { status: 'disabled' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('disabled');
  });

  it('operador não altera escopos', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(await logar(OPERADOR)),
      payload: { scopes: ['orders:write'] },
    });

    expect(res.statusCode).toBe(403);
  });

  // Aplicar só a parte operacional deixaria o chamador achando que a alteração toda passou.
  it('corpo misto sem superadmin é 403 e não aplica nada', async () => {
    const admin = await logar(ADMIN);
    const criado = await novoCliente(admin);

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(await logar(OPERADOR)),
      payload: { name: 'novo-nome', scopes: ['orders:write'] },
    });

    expect(res.statusCode).toBe(403);
    const lido = await app.inject({
      method: 'GET',
      url: `/clients/${criado.id}`,
      headers: bearer(admin),
    });
    expect(lido.json<{ name: string; scopes: string[] }>().name).not.toBe('novo-nome');
    expect(lido.json<{ scopes: string[] }>().scopes).toEqual(['orders:read']);
  });

  it('superadmin altera escopos e o conjunto é substituído', async () => {
    const token = await logar(ADMIN);
    const criado = await novoCliente(token);

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(token),
      payload: { scopes: ['orders:write'] },
    });

    expect(res.json<{ scopes: string[] }>().scopes).toEqual(['orders:write']);
  });

  it('recusa corpo vazio', async () => {
    const token = await logar(ADMIN);
    const criado = await novoCliente(token);

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(token),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('recusa tentativa de marcar como removido pelo patch', async () => {
    const token = await logar(ADMIN);
    const criado = await novoCliente(token);

    const res = await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(token),
      payload: { status: 'deleted' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /clients/:id', () => {
  it('remove logicamente e recusa a segunda vez', async () => {
    const admin = await logar(ADMIN);
    const criado = await novoCliente(admin);
    const operador = await logar(OPERADOR);

    const primeira = await app.inject({
      method: 'DELETE',
      url: `/clients/${criado.id}`,
      headers: bearer(operador),
    });
    const segunda = await app.inject({
      method: 'DELETE',
      url: `/clients/${criado.id}`,
      headers: bearer(operador),
    });

    expect(primeira.statusCode).toBe(204);
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json<{ type: string }>().type).toContain('client-already-deleted');
  });

  it('nega quem não tem clients:delete', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'DELETE',
      url: `/clients/${criado.id}`,
      headers: bearer(await logar(LEITOR)),
    });

    expect(res.statusCode).toBe(403);
  });

  it('devolve 404 para id inexistente', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/clients/00000000-0000-0000-0000-000000000000',
      headers: bearer(await logar(OPERADOR)),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /clients/:id/secret', () => {
  it('rotaciona e devolve um segredo diferente do original', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret`,
      headers: bearer(await logar(OPERADOR)),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ client_secret: string; previous_secret_expires_at: string }>();
    expect(corpo.client_secret).not.toBe(criado.client_secret);
    expect(Date.parse(corpo.previous_secret_expires_at)).toBeGreaterThan(Date.now());
  });

  it('com sobreposição zero não deixa segredo anterior', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret`,
      headers: bearer(await logar(OPERADOR)),
      payload: { overlap_seconds: 0 },
    });

    expect(res.json<{ previous_secret_expires_at: null }>().previous_secret_expires_at).toBeNull();
  });

  it('recusa sobreposição acima do teto de sete dias', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret`,
      headers: bearer(await logar(OPERADOR)),
      payload: { overlap_seconds: 604_801 },
    });

    expect(res.statusCode).toBe(400);
  });

  it('nega quem só tem clients:read', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret`,
      headers: bearer(await logar(LEITOR)),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('POST /clients/:id/secret/revoke-previous', () => {
  it('encerra a sobreposição em andamento', async () => {
    const criado = await novoCliente(await logar(ADMIN));
    const operador = await logar(OPERADOR);
    await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret`,
      headers: bearer(operador),
      payload: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret/revoke-previous`,
      headers: bearer(operador),
    });

    expect(res.statusCode).toBe(204);
  });

  it('recusa quando não havia sobreposição', async () => {
    const criado = await novoCliente(await logar(ADMIN));

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret/revoke-previous`,
      headers: bearer(await logar(OPERADOR)),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('no-previous-secret');
  });
});
