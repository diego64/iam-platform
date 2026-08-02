/**
 * CRUD de políticas ponta a ponta: guards do RBAC (BFLA), validação da gramática na borda,
 * imutabilidade das políticas de sistema e os limites de forma que impedem uma condição
 * gigante de chegar ao banco.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaAbac } from './schema.js';
import { montarAppDeAbac } from './helper-app.js';
import { recriarSchemaJwks } from '../jwks/schema.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-abac@iam.local';
const LEITOR = 'leitor-abac@iam.local';
const SEM_ACESSO = 'sem-acesso-abac@iam.local';

const POSSE = { op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } };

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.7.0.${String(ip)}`;
}

async function logar(email: string): Promise<{ authorization: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email, senha: SENHA },
  });
  return { authorization: `Bearer ${res.json<{ access_token: string }>().access_token}` };
}

async function criarUsuarioComPapel(
  email: string,
  servicoDeSenha: { gerarHash(s: string): Promise<string> },
  perms: string[],
  papelSuperadmin = false,
): Promise<string> {
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const userId = rows[0]?.id ?? '';

  if (papelSuperadmin) {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = 'superadmin'`,
      [userId],
    );
    return userId;
  }

  const papel = await pool.query<{ id: string }>(
    'INSERT INTO roles (name) VALUES ($1) RETURNING id',
    [`papel-${email.split('@')[0] ?? ''}`],
  );
  const roleId = papel.rows[0]?.id ?? '';
  if (perms.length > 0) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE name = ANY($2)`,
      [roleId, perms],
    );
  }
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId]);
  return userId;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaAbac(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  const montado = await montarAppDeAbac({ pool, banco });
  app = montado.app;

  await criarUsuarioComPapel(ADMIN, montado.servicoDeSenha, [], true);
  await criarUsuarioComPapel(LEITOR, montado.servicoDeSenha, ['policies:read']);
  await criarUsuarioComPapel(SEM_ACESSO, montado.servicoDeSenha, ['users:read']);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

function politica(parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'politica-de-teste',
    effect: 'permit',
    resource_type: 'doc',
    action: 'read',
    condition: POSSE,
    ...parcial,
  };
}

describe('guards do RBAC nas rotas de política (BFLA)', () => {
  it('sem token ⇒ 401, não 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/policies' });
    expect(res.statusCode).toBe(401);
  });

  it('sem policies:write ⇒ 403 ao criar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: await logar(LEITOR),
      payload: politica({ name: 'nao-deve-existir' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('authorization-denied');
  });

  it('sem policies:read ⇒ 403 ao listar e ao simular', async () => {
    const headers = await logar(SEM_ACESSO);
    const lista = await app.inject({ method: 'GET', url: '/policies', headers });
    const simulacao = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      headers,
      payload: { subject: { sub: 'u-1' }, resource_type: 'doc', resource: {}, action: 'read' },
    });
    expect(lista.statusCode).toBe(403);
    expect(simulacao.statusCode).toBe(403);
  });

  it('policies:read permite ler mas não deletar', async () => {
    const headers = await logar(LEITOR);
    const lista = await app.inject({ method: 'GET', url: '/policies', headers });
    expect(lista.statusCode).toBe(200);

    const alvo = lista.json<{ items: { id: string }[] }>().items[0];
    const remocao = await app.inject({
      method: 'DELETE',
      url: `/policies/${alvo?.id ?? ''}`,
      headers,
    });
    expect(remocao.statusCode).toBe(403);
  });
});

describe('CRUD (superadmin)', () => {
  it('cria (201), detalha (200), atualiza (200) e remove (204)', async () => {
    const headers = await logar(ADMIN);
    const criada = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'ciclo-completo', description: 'teste' }),
    });
    expect(criada.statusCode).toBe(201);
    const corpo = criada.json<{ id: string; is_system: boolean; priority: number }>();
    expect(corpo.is_system).toBe(false);
    expect(corpo.priority).toBe(0);

    const detalhe = await app.inject({
      method: 'GET',
      url: `/policies/${corpo.id}`,
      headers,
    });
    expect(detalhe.statusCode).toBe(200);
    expect(detalhe.json<{ condition: unknown }>().condition).toEqual(POSSE);
    expect(detalhe.json<{ description: string }>().description).toBe('teste');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/policies/${corpo.id}`,
      headers,
      payload: { priority: 42, enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ priority: number; enabled: boolean }>()).toMatchObject({
      priority: 42,
      enabled: false,
    });

    const remocao = await app.inject({
      method: 'DELETE',
      url: `/policies/${corpo.id}`,
      headers,
    });
    expect(remocao.statusCode).toBe(204);

    const sumiu = await app.inject({ method: 'GET', url: `/policies/${corpo.id}`, headers });
    expect(sumiu.statusCode).toBe(404);
  });

  it('nome duplicado ⇒ 409', async () => {
    const headers = await logar(ADMIN);
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'nome-unico' }),
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'nome-unico' }),
    });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json<{ type: string }>().type).toContain('policy-already-exists');
  });

  it('id inexistente ⇒ 404 em detalhe, patch e delete', async () => {
    const headers = await logar(ADMIN);
    const inexistente = '00000000-0000-0000-0000-000000000000';
    for (const [method, payload] of [
      ['GET', undefined],
      ['PATCH', { priority: 1 }],
      ['DELETE', undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url: `/policies/${inexistente}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('filtra a listagem por resource_type', async () => {
    const headers = await logar(ADMIN);
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'filtro-alvo', resource_type: 'invoice' }),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/policies?resource_type=invoice',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items, total } = res.json<{ items: { name: string }[]; total: number }>();
    expect(total).toBe(1);
    expect(items[0]?.name).toBe('filtro-alvo');
  });
});

describe('imutabilidade das políticas de sistema', () => {
  it('PATCH e DELETE de system-ownership ⇒ 409', async () => {
    const headers = await logar(ADMIN);
    const lista = await app.inject({
      method: 'GET',
      url: '/policies?resource_type=*',
      headers,
    });
    const sistema = lista
      .json<{ items: { id: string; name: string }[] }>()
      .items.find((p) => p.name === 'system-ownership');
    expect(sistema).toBeDefined();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/policies/${sistema?.id ?? ''}`,
      headers,
      payload: { enabled: false },
    });
    const remocao = await app.inject({
      method: 'DELETE',
      url: `/policies/${sistema?.id ?? ''}`,
      headers,
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json<{ type: string }>().type).toContain('system-policy-immutable');
    expect(remocao.statusCode).toBe(409);
  });
});

describe('validação da gramática na borda', () => {
  /** Aninha `not` até `niveis` de profundidade. */
  function aninhar(niveis: number): unknown {
    let no: unknown = { op: 'eq', attr: 'subject.sub', value: 'u-1' };
    for (let i = 1; i < niveis; i += 1) no = { op: 'not', of: [no] };
    return no;
  }

  it('operador fora da whitelist ⇒ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: await logar(ADMIN),
      payload: politica({
        name: 'op-invalido',
        condition: { op: 'regex', attr: 'resource.name', value: '^a' },
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('condição profunda demais ⇒ 400 e não persiste', async () => {
    const headers = await logar(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'profunda-demais', condition: aninhar(30) }),
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await pool.query("SELECT 1 FROM policies WHERE name = 'profunda-demais'");
    expect(rows).toHaveLength(0);
  });

  it('efeito fora de permit|deny e campo extra ⇒ 400', async () => {
    const headers = await logar(ADMIN);
    const efeito = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: politica({ name: 'efeito-ruim', effect: 'maybe' }),
    });
    const extra = await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: { ...politica({ name: 'campo-extra' }), admin: true },
    });
    expect(efeito.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
  });
});
