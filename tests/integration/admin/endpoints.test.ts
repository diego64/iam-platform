/**
 * Cobre as rotas do painel ponta a ponta contra bancos reais.
 *
 * O caso central é a lacuna que este módulo existe para fechar: um administrador vê e encerra
 * a sessão de outra pessoa, e o efeito é real — o refresh daquela família para de funcionar.
 * O resto verifica que a agregação responde, que nada sensível vaza na ficha e que cada rota
 * exige o privilégio certo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarCheckpoints } from '../audit/schema.js';
import { montarAppDeAdmin } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'painel@iam.local';
const LEITOR = 'leitor@iam.local';
const ALVO = 'alvo@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let servicoDeSenha: Awaited<ReturnType<typeof montarAppDeAdmin>>['servicoDeSenha'];
let tokenAdmin: string;
let tokenLeitor: string;
let adminId: string;
let alvoId: string;
let ip = 0;

type Resposta = Awaited<ReturnType<FastifyInstance['inject']>>;

function proximoIp(): string {
  ip += 1;
  return `10.6.0.${String(ip)}`;
}

async function logar(email: string): Promise<{ access: string; refresh: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email, senha: SENHA },
  });
  const corpo = res.json<{ access_token: string; refresh_token: string }>();
  return { access: corpo.access_token, refresh: corpo.refresh_token };
}

async function criarUsuario(email: string, permissoes: string[]): Promise<string> {
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const userId = rows[0]?.id ?? '';
  if (permissoes.length === 0) return userId;

  const papel = `papel-${email.split('@')[0] ?? 'x'}`;
  await pool.query('INSERT INTO roles (name) VALUES ($1) ON CONFLICT DO NOTHING', [papel]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE name = $2 ON CONFLICT DO NOTHING`,
    [userId, papel],
  );
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
      WHERE r.name = $1 AND p.name = ANY($2::text[]) ON CONFLICT DO NOTHING`,
    [papel, permissoes],
  );
  return userId;
}

function comToken(metodo: 'GET' | 'DELETE', url: string, token: string): Promise<Resposta> {
  return app.inject({ method: metodo, url, headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste() });
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);
  await aplicarMetadadosRbac(pool);
  await recriarCheckpoints(pool);
  await pool.query(
    `INSERT INTO permissions (name, description, is_system) VALUES
       ('admin:read','',true), ('sessions:read','',true), ('sessions:revoke','',true)
     ON CONFLICT (name) DO NOTHING`,
  );
  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});
  await banco.collection('refresh_tokens').deleteMany({});

  ({ app, servicoDeSenha } = await montarAppDeAdmin({ pool, banco }));

  adminId = await criarUsuario(ADMIN, ['admin:read', 'sessions:read', 'sessions:revoke']);
  await criarUsuario(LEITOR, ['admin:read']);
  alvoId = await criarUsuario(ALVO, []);

  tokenAdmin = (await logar(ADMIN)).access;
  tokenLeitor = (await logar(LEITOR)).access;
}, 60_000);

afterAll(async () => {
  await app.close();
  await cliente.close();
  await pool.end();
});

describe('GET /admin/overview', () => {
  it('devolve números coerentes com o estado dos bancos', async () => {
    const res = await comToken('GET', '/admin/overview', tokenAdmin);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{
      usuarios: { active: number; total: number };
      sessoes_ativas: number | null;
      logins_24h: { sucesso: number } | null;
      chave_ativa: { kid: string } | null;
      parcial: boolean;
    }>();
    expect(corpo.usuarios.active).toBeGreaterThanOrEqual(3);
    expect(corpo.usuarios.total).toBe(corpo.usuarios.active);
    expect(corpo.sessoes_ativas).toBeGreaterThanOrEqual(2);
    expect(corpo.logins_24h?.sucesso).toBeGreaterThanOrEqual(2);
    expect(corpo.chave_ativa?.kid).toBeTruthy();
    expect(corpo.parcial).toBe(false);
  });

  it('declara o instante da apuração e se veio do cache', async () => {
    const { app: comCache } = await montarAppDeAdmin({ pool, banco, janelaDeCacheMs: 30_000 });

    const primeira = await comCache.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    const segunda = await comCache.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(primeira.json<{ cache: string }>().cache).toBe('miss');
    expect(segunda.json<{ cache: string }>().cache).toBe('hit');
    expect(segunda.json<{ apurado_em: string }>().apurado_em).toBe(
      primeira.json<{ apurado_em: string }>().apurado_em,
    );
    await comCache.close();
  });

  it('nega quem não tem admin:read', async () => {
    const semPermissao = (await logar(ALVO)).access;

    expect((await comToken('GET', '/admin/overview', semPermissao)).statusCode).toBe(403);
  });

  it('nega sem token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/overview' })).statusCode).toBe(401);
  });
});

describe('GET /admin/users/:id', () => {
  it('agrega perfil, papéis, permissões, sessões e eventos numa chamada', async () => {
    const res = await comToken('GET', `/admin/users/${adminId}`, tokenAdmin);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{
      perfil: { email: string };
      papeis: unknown[] | null;
      permissoes: string[] | null;
      sessoes: unknown[] | null;
      eventos: unknown[] | null;
    }>();
    expect(corpo.perfil.email).toBe(ADMIN);
    expect(corpo.papeis).toHaveLength(1);
    expect(corpo.permissoes).toContain('admin:read');
    expect(corpo.sessoes?.length).toBeGreaterThanOrEqual(1);
    expect(corpo.eventos?.length).toBeGreaterThanOrEqual(1);
  });

  it('não deixa campo sensível chegar à resposta', async () => {
    const res = await comToken('GET', `/admin/users/${adminId}`, tokenAdmin);

    const serializada = res.body.toLowerCase();
    // O bloco `senha: { alterada_em }` é campo documentado e não carrega segredo nenhum —
    // o que não pode aparecer é o material: hash, token e segredo de cliente.
    for (const proibida of ['password', 'senha_hash', 'token_hash', 'secret', 'scrypt$']) {
      expect(serializada).not.toContain(proibida);
    }
    expect(res.json<{ senha: { alterada_em: string | null } }>().senha).toHaveProperty(
      'alterada_em',
    );
  });

  it('responde 404 para usuário inexistente e 400 para id que não é UUID', async () => {
    const inexistente = '00000000-0000-4000-8000-000000000000';
    expect((await comToken('GET', `/admin/users/${inexistente}`, tokenAdmin)).statusCode).toBe(404);
    expect((await comToken('GET', '/admin/users/nao-uuid', tokenAdmin)).statusCode).toBe(400);
  });
});

describe('sessões de terceiros', () => {
  it('lista as sessões abertas do alvo', async () => {
    await logar(ALVO);

    const res = await comToken('GET', `/admin/users/${alvoId}/sessions`, tokenAdmin);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ itens: { session_id: string }[]; total: number }>();
    expect(corpo.total).toBeGreaterThanOrEqual(1);
    expect(corpo.itens[0]?.session_id).toBeTruthy();
  });

  it('encerrar uma sessão derruba o refresh daquela família', async () => {
    const sessao = await logar(ALVO);
    const listadas = await comToken('GET', `/admin/users/${alvoId}/sessions`, tokenAdmin);
    const sessionId = listadas.json<{ itens: { session_id: string }[] }>().itens[0]?.session_id;
    expect(sessionId).toBeTruthy();

    const revogacao = await comToken(
      'DELETE',
      `/admin/users/${alvoId}/sessions/${String(sessionId)}`,
      tokenAdmin,
    );
    expect(revogacao.statusCode).toBe(204);

    // O refresh daquela família precisa parar de funcionar; se ele ainda rodar, a revogação
    // encerrou algo que não era a sessão.
    const depois = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: proximoIp(),
      payload: { refresh_token: sessao.refresh },
    });
    expect(depois.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('encerrar todas devolve quantas caíram', async () => {
    await logar(ALVO);
    await logar(ALVO);

    const res = await comToken('DELETE', `/admin/users/${alvoId}/sessions`, tokenAdmin);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ revogadas: number }>().revogadas).toBeGreaterThanOrEqual(2);
    expect(
      (await comToken('GET', `/admin/users/${alvoId}/sessions`, tokenAdmin)).json<{
        total: number;
      }>().total,
    ).toBe(0);
  });

  it('registra a revogação na trilha com ator e alvo', async () => {
    await logar(ALVO);
    await comToken('DELETE', `/admin/users/${alvoId}/sessions`, tokenAdmin);

    const evento = await banco
      .collection('audit_log')
      .findOne({ type: 'iam.session.revoked' }, { sort: { seq: -1 } });

    expect(evento?.['actor']).toMatchObject({ id: adminId });
    expect(evento?.['target']).toMatchObject({ id: alvoId, type: 'user' });
  });

  it('recusa o administrador que aponta para a própria sessão', async () => {
    const res = await comToken('DELETE', `/admin/users/${adminId}/sessions`, tokenAdmin);

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('exige sessions:revoke — admin:read não basta', async () => {
    expect(
      (await comToken('DELETE', `/admin/users/${alvoId}/sessions`, tokenLeitor)).statusCode,
    ).toBe(403);
  });

  it('exige sessions:read para listar', async () => {
    expect((await comToken('GET', `/admin/users/${alvoId}/sessions`, tokenLeitor)).statusCode).toBe(
      403,
    );
  });

  it('responde 404 para sessão inexistente, sem revogar nada', async () => {
    const inexistente = '00000000-0000-4000-8000-000000000000';

    expect(
      (await comToken('DELETE', `/admin/users/${alvoId}/sessions/${inexistente}`, tokenAdmin))
        .statusCode,
    ).toBe(404);
  });
});
