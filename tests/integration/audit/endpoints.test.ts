/**
 * Cobre as rotas de auditoria ponta a ponta contra bancos reais: o login grava na trilha, a
 * leitura filtra e pagina, a verificação aprova a cadeia honesta e acusa cada forma de
 * adulteração, e a escrita externa é recusada por contrato.
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
import { recriarCheckpoints } from './schema.js';
import { montarAppDeAuditoria } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const AUDITOR = 'auditor@iam.local';
const CURIOSO = 'curioso@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let tokenAuditor: string;
let tokenCurioso: string;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.7.0.${String(ip)}`;
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

async function comPermissoes(email: string, permissoes: string[]): Promise<void> {
  const { servicoDeSenha } = await montarAppDeAuditoria({ pool, banco });
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const userId = rows[0]?.id ?? '';
  if (permissoes.length === 0) return;

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
       ('audit:read','',true), ('audit:verify','',true) ON CONFLICT (name) DO NOTHING`,
  );
  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});

  ({ app } = await montarAppDeAuditoria({ pool, banco }));

  await comPermissoes(AUDITOR, ['audit:read', 'audit:verify']);
  await comPermissoes(CURIOSO, []);

  // Cada login grava um evento: é a trilha real que os testes de leitura consultam.
  tokenAuditor = await logar(AUDITOR);
  tokenCurioso = await logar(CURIOSO);
  await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    // Senha com tamanho válido: mais curta que o mínimo pararia no Zod e nunca chegaria ao
    // serviço, então não haveria falha de credencial para registrar.
    payload: { email: 'ninguem@iam.local', senha: 'ErradaMesmo!1' },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await cliente.close();
  await pool.end();
});

type Resposta = Awaited<ReturnType<FastifyInstance['inject']>>;

function autenticado(url: string, token: string): Promise<Resposta> {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('GET /audit/events', () => {
  it('lista os eventos gravados pelos logins', async () => {
    const res = await autenticado('/audit/events', tokenAuditor);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ itens: { type: string; seq: number }[] }>();
    expect(corpo.itens.length).toBeGreaterThanOrEqual(3);
    expect(corpo.itens.map((item) => item.type)).toContain('iam.auth.login');
    expect(corpo.itens.map((item) => item.type)).toContain('iam.auth.login_failed');
  });

  it('filtra por tipo', async () => {
    const res = await autenticado('/audit/events?type=iam.auth.login_failed', tokenAuditor);

    const itens = res.json<{ itens: { type: string }[] }>().itens;
    expect(itens.length).toBeGreaterThan(0);
    expect(itens.every((item) => item.type === 'iam.auth.login_failed')).toBe(true);
  });

  it('guarda a pista do sujeito sem o e-mail digitado', async () => {
    const res = await autenticado('/audit/events?type=iam.auth.login_failed', tokenAuditor);

    const item = res.json<{ itens: { subject_hint: string | null }[] }>().itens[0];
    expect(item?.subject_hint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.json())).not.toContain('ninguem@iam.local');
  });

  it('registra a origem da chamada a partir do contexto da requisição', async () => {
    const res = await autenticado('/audit/events?type=iam.auth.login', tokenAuditor);

    const item = res.json<{ itens: { actor: { ip?: string } }[] }>().itens[0];
    expect(item?.actor.ip).toMatch(/^10\.7\.0\./);
  });

  it('pagina por cursor', async () => {
    const primeira = await autenticado('/audit/events?limite=1', tokenAuditor);
    const cursor = primeira.json<{ proximo_cursor: number | null }>().proximo_cursor;
    expect(cursor).not.toBeNull();

    const segunda = await autenticado(
      `/audit/events?limite=1&cursor=${String(cursor)}`,
      tokenAuditor,
    );

    expect(segunda.json<{ itens: { seq: number }[] }>().itens[0]?.seq).toBe(cursor);
  });

  it('não devolve o elo anterior na listagem', async () => {
    const res = await autenticado('/audit/events?limite=1', tokenAuditor);

    expect(res.json<{ itens: Record<string, unknown>[] }>().itens[0]).not.toHaveProperty(
      'prev_hash',
    );
  });

  it('recusa filtro com campo extra', async () => {
    const res = await autenticado('/audit/events?inventado=1', tokenAuditor);

    expect(res.statusCode).toBe(400);
  });

  it('recusa limite acima do teto e ator que não é UUID', async () => {
    expect((await autenticado('/audit/events?limite=201', tokenAuditor)).statusCode).toBe(400);
    expect((await autenticado('/audit/events?actor_id=nao-uuid', tokenAuditor)).statusCode).toBe(
      400,
    );
  });

  it('nega quem não tem audit:read', async () => {
    const res = await autenticado('/audit/events', tokenCurioso);

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('nega sem token', async () => {
    expect((await app.inject({ method: 'GET', url: '/audit/events' })).statusCode).toBe(401);
  });
});

describe('GET /audit/events/:seq', () => {
  it('devolve o evento com o elo anterior', async () => {
    const res = await autenticado('/audit/events/1', tokenAuditor);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ prev_hash: string }>().prev_hash).toBe('0'.repeat(64));
  });

  it('responde 404 para posição inexistente', async () => {
    expect((await autenticado('/audit/events/999999', tokenAuditor)).statusCode).toBe(404);
  });
});

describe('POST /audit/events', () => {
  it('recusa escrita externa com 405', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/audit/events',
      headers: { authorization: `Bearer ${tokenAuditor}` },
      payload: {},
    });

    expect(res.statusCode).toBe(405);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});

describe('GET /audit/integrity', () => {
  it('aprova a cadeia honesta', async () => {
    const res = await autenticado('/audit/integrity', tokenAuditor);

    expect(res.statusCode).toBe(200);
    const corpo = res.json<{ integra: boolean; verificados: number }>();
    expect(corpo.integra).toBe(true);
    expect(corpo.verificados).toBeGreaterThan(0);
  });

  it('exige audit:verify, não basta audit:read', async () => {
    expect((await autenticado('/audit/integrity', tokenCurioso)).statusCode).toBe(403);
  });

  it('recusa faixa invertida e janela acima do teto', async () => {
    expect((await autenticado('/audit/integrity?de=10&ate=2', tokenAuditor)).statusCode).toBe(400);

    const { app: appApertado } = await montarAppDeAuditoria({ pool, banco, janelaMaxima: 2 });
    const res = await appApertado.inject({
      method: 'GET',
      url: '/audit/integrity?de=1&ate=100',
      headers: { authorization: `Bearer ${tokenAuditor}` },
    });
    expect(res.statusCode).toBe(400);
    await appApertado.close();
  });

  it('acusa hash divergente quando um evento é alterado no banco', async () => {
    await banco.collection('audit_log').updateOne({ seq: 2 }, { $set: { outcome: 'failure' } });

    const res = await autenticado('/audit/integrity', tokenAuditor);

    const corpo = res.json<{
      integra: boolean;
      primeira_quebra: { seq: number; motivo: string } | null;
    }>();
    expect(res.statusCode).toBe(200);
    expect(corpo.integra).toBe(false);
    expect(corpo.primeira_quebra).toEqual({ seq: 2, motivo: 'hash-divergente' });

    await banco.collection('audit_log').updateOne({ seq: 2 }, { $set: { outcome: 'success' } });
  });

  it('acusa posição faltante quando um evento é removido do meio', async () => {
    const removido = await banco.collection('audit_log').findOne({ seq: 2 });
    await banco.collection('audit_log').deleteOne({ seq: 2 });

    const corpo = (await autenticado('/audit/integrity', tokenAuditor)).json<{
      primeira_quebra: { seq: number; motivo: string } | null;
    }>();
    expect(corpo.primeira_quebra).toEqual({ seq: 2, motivo: 'seq-faltante' });

    if (removido !== null) await banco.collection('audit_log').insertOne(removido);
  });

  it('acusa divergência de âncora quando o fim da trilha é cortado', async () => {
    const topo = await app
      .inject({
        method: 'GET',
        url: '/audit/events?limite=200',
        headers: { authorization: `Bearer ${tokenAuditor}` },
      })
      .then((res) => res.json<{ itens: { seq: number; hash: string }[] }>().itens);
    const ultimo = topo.at(-1);
    expect(ultimo).toBeDefined();

    // Uma âncora à frente do topo é, por si só, prova de que a trilha encolheu.
    await pool.query('INSERT INTO audit_checkpoints (seq, hash) VALUES ($1, $2)', [
      (ultimo?.seq ?? 0) + 50,
      'f'.repeat(64),
    ]);

    const corpo = (await autenticado('/audit/integrity', tokenAuditor)).json<{
      integra: boolean;
      primeira_quebra: { motivo: string } | null;
      checkpoint_conferido: { confere: boolean } | null;
    }>();

    expect(corpo.integra).toBe(false);
    expect(corpo.primeira_quebra?.motivo).toBe('checkpoint-divergente');
    expect(corpo.checkpoint_conferido?.confere).toBe(false);

    await pool.query('TRUNCATE audit_checkpoints');
  });
});
