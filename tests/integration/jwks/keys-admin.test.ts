/**
 * Cobre as rotas administrativas de chaves ponta a ponta contra bancos reais: a
 * idempotência do preparo, os três 409 da promoção, a autoridade de cada rota (BFLA) e a
 * garantia de contrato de que nenhuma resposta carrega material de chave.
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
import { recriarSchemaJwks } from './schema.js';
import { montarAppDeChaves } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-keys@iam.local';
const OPERADOR = 'operador-keys@iam.local';
const LEITOR = 'leitor-keys@iam.local';
const SEM_NADA = 'zero-keys@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let repo: Awaited<ReturnType<typeof montarAppDeChaves>>['repo'];
let servicoDeSenha: Awaited<ReturnType<typeof montarAppDeChaves>>['servicoDeSenha'];
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.11.0.${String(ip % 250)}`;
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

async function criarUsuario(email: string): Promise<string> {
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
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

async function atribuirPapel(email: string, roleId: string): Promise<void> {
  await pool.query(
    'INSERT INTO user_roles (user_id, role_id) SELECT id, $2 FROM users WHERE email = $1',
    [email, roleId],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  ({ app, servicoDeSenha, repo } = await montarAppDeChaves({ pool, banco }));

  await criarUsuario(ADMIN);
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM roles WHERE name = 'superadmin'",
  );
  await atribuirPapel(ADMIN, rows[0]?.id ?? '');

  await criarUsuario(OPERADOR);
  await atribuirPapel(
    OPERADOR,
    await criarPapelComPerms('keys-operador', ['keys:read', 'keys:write']),
  );

  await criarUsuario(LEITOR);
  await atribuirPapel(LEITOR, await criarPapelComPerms('keys-leitor', ['keys:read']));

  await criarUsuario(SEM_NADA);
});

beforeEach(async () => {
  // Volta ao estado de repouso mínimo: uma ativa, nada mais.
  await pool.query("DELETE FROM jwks WHERE status <> 'active'");
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('GET /admin/keys', () => {
  it('lista as chaves para quem tem keys:read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: bearer(await logar(LEITOR)),
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ items: { status: string }[]; total: number }>();
    expect(corpo.total).toBeGreaterThanOrEqual(1);
    expect(corpo.items.some((c) => c.status === 'active')).toBe(true);
  });

  it('filtra por status', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(await logar(OPERADOR)),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys?status=next',
      headers: bearer(await logar(LEITOR)),
    });

    const corpo = res.json<{ items: { status: string }[] }>();
    expect(corpo.items).toHaveLength(1);
    expect(corpo.items[0]?.status).toBe('next');
  });

  // A resposta estrita é a garantia; esta asserção existe para o caso de o schema afrouxar.
  it('jamais devolve material de chave', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: bearer(await logar(LEITOR)),
    });

    const bruto = res.body;
    expect(bruto).not.toContain('private_key_enc');
    expect(bruto).not.toContain('privateKeyEnc');
    expect(bruto).not.toContain('public_jwk');
    expect(bruto).not.toMatch(/"d"\s*:/);
  });

  it('nega quem não tem keys:read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: bearer(await logar(SEM_NADA)),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('authorization-denied');
  });

  it('nega sem token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/keys' })).statusCode).toBe(401);
  });

  it('rejeita status fora do conjunto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys?status=inventado',
      headers: bearer(await logar(LEITOR)),
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/keys/prepare', () => {
  it('cria a pré-publicada na primeira chamada e reaproveita na segunda', async () => {
    const token = await logar(OPERADOR);

    const primeira = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });

    expect(primeira.statusCode).toBe(201);
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json<{ kid: string }>().kid).toBe(primeira.json<{ kid: string }>().kid);
    expect((await repo.contarPorStatus()).next).toBe(1);
  });

  it('informa a partir de quando a promoção é liberada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(await logar(OPERADOR)),
    });

    const corpo = res.json<{ created_at: string; rotatable_at: string }>();
    expect(Date.parse(corpo.rotatable_at)).toBeGreaterThanOrEqual(Date.parse(corpo.created_at));
  });

  it('nega quem só tem keys:read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(await logar(LEITOR)),
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/keys/rotate', () => {
  it('recusa quando não há chave pré-publicada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(await logar(OPERADOR)),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('no-next-key');
  });

  it('promove a pré-publicada e devolve os três kids', async () => {
    const token = await logar(OPERADOR);
    const anterior = (await repo.obterAtiva())?.kid;
    const preparada = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(token),
      payload: { motivo: 'rotação de teste' },
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{
      previous_kid: string;
      active_kid: string;
      next_kid: string;
      verifiable_until: string;
    }>();
    expect(corpo.previous_kid).toBe(anterior);
    expect(corpo.active_kid).toBe(preparada.json<{ kid: string }>().kid);
    expect(corpo.next_kid).not.toBe(corpo.active_kid);
    expect(Date.parse(corpo.verifiable_until)).toBeGreaterThan(Date.now());
  });

  it('deixa o repouso com uma ativa e uma pré-publicada', async () => {
    const token = await logar(OPERADOR);
    await app.inject({ method: 'POST', url: '/admin/keys/prepare', headers: bearer(token) });

    await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(token),
      payload: {},
    });

    expect(await repo.contarPorStatus()).toMatchObject({ active: 1, next: 1 });
  });

  it('rejeita motivo curto demais', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(await logar(OPERADOR)),
      payload: { motivo: 'x' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejeita campo extra no corpo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(await logar(OPERADOR)),
      payload: { motivo: 'valido', forcar: true },
    });

    expect(res.statusCode).toBe(400);
  });

  it('nega quem só tem keys:read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: bearer(await logar(LEITOR)),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/keys/:kid/revoke', () => {
  it('exige o papel superadmin, não bastando keys:write', async () => {
    const token = await logar(OPERADOR);
    const preparada = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${preparada.json<{ kid: string }>().kid}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'tentativa indevida' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('revoga a pré-publicada sem invalidar token nenhum', async () => {
    const token = await logar(ADMIN);
    const preparada = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${preparada.json<{ kid: string }>().kid}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'privada exposta em log' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ tokens_invalidated: boolean }>().tokens_invalidated).toBe(false);
  });

  it('revoga a ativa promovendo a pré-publicada no mesmo passo', async () => {
    const token = await logar(ADMIN);
    const ativaAntes = (await repo.obterAtiva())?.kid ?? '';
    const preparada = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${ativaAntes}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'privada comprometida' },
    });

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ active_kid: string; tokens_invalidated: boolean }>();
    expect(corpo.active_kid).toBe(preparada.json<{ kid: string }>().kid);
    expect(corpo.tokens_invalidated).toBe(true);
    expect(await repo.obterAtiva()).not.toBeNull();
  });

  it('recusa revogar a ativa sem candidata pronta', async () => {
    const token = await logar(ADMIN);
    const ativa = (await repo.obterAtiva())?.kid ?? '';

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${ativa}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'sem candidata' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('no-next-key');
    expect((await repo.obterAtiva())?.kid).toBe(ativa);
  });

  it('devolve 404 para kid inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/0193b6e2-7f00-7cd1-9a3e-2b7c9f0a1d42/revoke',
      headers: bearer(await logar(ADMIN)),
      payload: { motivo: 'inexistente' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toContain('key-not-found');
  });

  it('recusa revogar duas vezes a mesma chave', async () => {
    const token = await logar(ADMIN);
    const preparada = await app.inject({
      method: 'POST',
      url: '/admin/keys/prepare',
      headers: bearer(token),
    });
    const kid = preparada.json<{ kid: string }>().kid;
    await app.inject({
      method: 'POST',
      url: `/admin/keys/${kid}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'primeira' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/keys/${kid}/revoke`,
      headers: bearer(token),
      payload: { motivo: 'segunda' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('key-already-revoked');
  });

  it('exige motivo — revogação sempre tem causa', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/0193b6e2-7f00-7cd1-9a3e-2b7c9f0a1d42/revoke',
      headers: bearer(await logar(ADMIN)),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejeita kid que não é uuid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/nao-e-uuid/revoke',
      headers: bearer(await logar(ADMIN)),
      payload: { motivo: 'formato invalido' },
    });

    expect(res.statusCode).toBe(400);
  });
});
