/**
 * Cobre as rotas do RBAC ponta a ponta contra bancos reais: CRUD de papéis/permissões,
 * associação, guard de permissão (BFLA), guard de superadmin (RF-09), imutabilidade de
 * is_system e o efeito no token (login do usuário passa a carregar a permissão concedida).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarMetadadosRbac } from './schema.js';
import { montarAppDeRbac } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin@iam.local';
const WRITER = 'writer@iam.local';
const READER = 'reader@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let servicoDeSenha: Awaited<ReturnType<typeof montarAppDeRbac>>['servicoDeSenha'];
let readerId: string;
let writerRoleId: string;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.9.0.${String(ip)}`;
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

async function criarUsuario(email: string): Promise<string> {
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  return rows[0]?.id ?? '';
}

async function idDePapel(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [name]);
  return rows[0]?.id ?? '';
}

async function idDePermissao(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM permissions WHERE name = $1', [
    name,
  ]);
  return rows[0]?.id ?? '';
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

async function atribuirPapel(userId: string, roleId: string): Promise<void> {
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId]);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool); // 0001 + password_history
  await aplicarMetadadosRbac(pool); // 0004 (metadados + seed superadmin/permissões-base)
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  ({ app, servicoDeSenha } = await montarAppDeRbac({ pool, banco }));

  // Admin = superadmin (seed). Writer = todas as permissões de rbac, sem o papel superadmin.
  // Reader = só roles:read.
  const adminId = await criarUsuario(ADMIN);
  await atribuirPapel(adminId, await idDePapel('superadmin'));

  const writerId = await criarUsuario(WRITER);
  writerRoleId = await criarPapelComPerms('rbac-writer', [
    'roles:read',
    'roles:write',
    'roles:delete',
    'permissions:read',
    'permissions:write',
    'permissions:delete',
  ]);
  await atribuirPapel(writerId, writerRoleId);

  readerId = await criarUsuario(READER);
  const readerRoleId = await criarPapelComPerms('rbac-reader', ['roles:read']);
  await atribuirPapel(readerId, readerRoleId);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('guard de permissão (BFLA)', () => {
  it('reader (roles:read) recebe 403 ao criar papel', async () => {
    const token = await logar(READER);
    const res = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(token),
      payload: { name: 'novo-papel' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('authorization-denied');
  });

  it('sem token ⇒ 401, não 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/roles' });
    expect(res.statusCode).toBe(401);
  });
});

describe('CRUD de papéis e permissões (writer)', () => {
  it('cria papel (201), lista (200), detalha (200) e atualiza (200)', async () => {
    const token = await logar(WRITER);
    const criado = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(token),
      payload: { name: 'billing-admin', description: 'Cobrança' },
    });
    expect(criado.statusCode).toBe(201);
    const roleId = criado.json<{ id: string }>().id;

    const lista = await app.inject({ method: 'GET', url: '/roles', headers: bearer(token) });
    expect(lista.statusCode).toBe(200);
    expect(lista.json<{ total: number }>().total).toBeGreaterThanOrEqual(1);

    const detalhe = await app.inject({
      method: 'GET',
      url: `/roles/${roleId}`,
      headers: bearer(token),
    });
    expect(detalhe.statusCode).toBe(200);
    expect(detalhe.json<{ permissions: string[] }>().permissions).toEqual([]);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/roles/${roleId}`,
      headers: bearer(token),
      payload: { description: 'Cobrança e faturas' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ description: string }>().description).toBe('Cobrança e faturas');
  });

  it('cria permissão (201) e o superadmin a associa a um papel (204)', async () => {
    const token = await logar(WRITER);
    const papel = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(token),
      payload: { name: 'suporte' },
    });
    const roleId = papel.json<{ id: string }>().id;
    const perm = await app.inject({
      method: 'POST',
      url: '/permissions',
      headers: bearer(token),
      payload: { name: 'tickets:read' },
    });
    expect(perm.statusCode).toBe(201);
    const permId = perm.json<{ id: string }>().id;

    const assoc = await app.inject({
      method: 'POST',
      url: `/roles/${roleId}/permissions`,
      headers: bearer(await logar(ADMIN)),
      payload: { permission_ids: [permId] },
    });
    expect(assoc.statusCode).toBe(204);

    const detalhe = await app.inject({
      method: 'GET',
      url: `/roles/${roleId}`,
      headers: bearer(token),
    });
    expect(detalhe.json<{ permissions: string[] }>().permissions).toEqual(['tickets:read']);
  });

  it('400 para corpo inválido (campo extra / nome de permissão sem `:`)', async () => {
    const token = await logar(WRITER);
    const extra = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(token),
      payload: { name: 'x', admin: true },
    });
    const nomeRuim = await app.inject({
      method: 'POST',
      url: '/permissions',
      headers: bearer(token),
      payload: { name: 'semdoispontos' },
    });
    expect(extra.statusCode).toBe(400);
    expect(nomeRuim.statusCode).toBe(400);
  });
});

describe('conceder permissão é exclusivo do superadmin', () => {
  it('writer com roles:write NÃO associa permissão a papel ⇒ 403', async () => {
    const token = await logar(WRITER);
    const permId = await idDePermissao('roles:delete');
    const res = await app.inject({
      method: 'POST',
      url: `/roles/${writerRoleId}/permissions`,
      headers: bearer(token),
      payload: { permission_ids: [permId] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('nem o superadmin associa o curinga `*` a outro papel ⇒ 409', async () => {
    const token = await logar(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: `/roles/${writerRoleId}/permissions`,
      headers: bearer(token),
      payload: { permission_ids: [await idDePermissao('*')] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('system-permission-immutable');
  });

  it('desassociar continua em roles:write (não escala privilégio)', async () => {
    const token = await logar(WRITER);
    // Papel descartável: desassociar do papel do próprio writer o deixaria sem permissão
    // para os testes seguintes.
    const papel = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(token),
      payload: { name: 'descartavel' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/roles/${papel.json<{ id: string }>().id}/permissions/${await idDePermissao('roles:delete')}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('imutabilidade de is_system', () => {
  it('DELETE de papel superadmin ⇒ 409', async () => {
    const token = await logar(WRITER);
    const superId = await idDePapel('superadmin');
    const res = await app.inject({
      method: 'DELETE',
      url: `/roles/${superId}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('system-role-immutable');
  });

  it('DELETE de permissão is_system (roles:write) ⇒ 409', async () => {
    const token = await logar(WRITER);
    const permId = await idDePermissao('roles:write');
    const res = await app.inject({
      method: 'DELETE',
      url: `/permissions/${permId}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('system-permission-immutable');
  });
});

describe('vínculo usuário↔papel (RF-09: só superadmin)', () => {
  it('writer com roles:write NÃO atribui papel a usuário ⇒ 403', async () => {
    const token = await logar(WRITER);
    const res = await app.inject({
      method: 'POST',
      url: `/users/${readerId}/roles`,
      headers: bearer(token),
      payload: { role_ids: [writerRoleId] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('superadmin atribui papel e o novo login do usuário passa a carregar a permissão', async () => {
    const adminToken = await logar(ADMIN);
    const atribuir = await app.inject({
      method: 'POST',
      url: `/users/${readerId}/roles`,
      headers: bearer(adminToken),
      payload: { role_ids: [writerRoleId] },
    });
    expect(atribuir.statusCode).toBe(204);

    const lista = await app.inject({
      method: 'GET',
      url: `/users/${readerId}/roles`,
      headers: bearer(adminToken),
    });
    expect(lista.statusCode).toBe(200);
    expect(lista.json<{ roles: { name: string }[] }>().roles.map((r) => r.name)).toContain(
      'rbac-writer',
    );

    // O reader agora tem roles:write via o papel concedido: consegue criar papel.
    const readerToken = await logar(READER);
    const criar = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: bearer(readerToken),
      payload: { name: 'papel-do-reader' },
    });
    expect(criar.statusCode).toBe(201);
  });
});
