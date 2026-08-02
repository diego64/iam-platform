/**
 * O simulador é o PDP exposto: mesma decisão do guard, sem enforcement e sem carregar
 * recurso. Vale como depuração e como decisão para consumidor externo, então o `policy_id`
 * decisivo faz parte do contrato — sem ele não dá para saber *qual* política negou.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaAbac } from './schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { montarAppDeAbac } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-eval@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let headers: { authorization: string };
let idDaPosse: string;

async function avaliar(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  corpo: { effect: string; policy_id?: string; reason: string };
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/policies/evaluate',
    headers,
    payload,
  });
  return {
    statusCode: res.statusCode,
    corpo: res.json<{ effect: string; policy_id?: string; reason: string }>(),
  };
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

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [ADMIN, hash],
  );
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE name = 'superadmin'`,
    [rows[0]?.id ?? ''],
  );

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: '10.6.0.1',
    payload: { email: ADMIN, senha: SENHA },
  });
  headers = { authorization: `Bearer ${login.json<{ access_token: string }>().access_token}` };

  const posse = await pool.query<{ id: string }>(
    "SELECT id FROM policies WHERE name = 'system-ownership'",
  );
  idDaPosse = posse.rows[0]?.id ?? '';
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('posse', () => {
  it('dono ⇒ permit, apontando a política de posse', async () => {
    const { statusCode, corpo } = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'doc',
      resource: { owner_id: 'u-1' },
      action: 'read',
    });
    expect(statusCode).toBe(200);
    expect(corpo).toEqual({ effect: 'permit', policy_id: idDaPosse, reason: 'matched' });
  });

  it('não-dono ⇒ deny por ausência de política aplicável', async () => {
    const { corpo } = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'doc',
      resource: { owner_id: 'outro-usuario' },
      action: 'read',
    });
    expect(corpo).toEqual({ effect: 'deny', reason: 'no-applicable-policy' });
  });

  it('recurso sem owner_id ⇒ deny', async () => {
    const { corpo } = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'doc',
      resource: { titulo: 'sem dono' },
      action: 'read',
    });
    expect(corpo.effect).toBe('deny');
  });
});

describe('override de privilégio', () => {
  it('quem carrega o curinga passa mesmo sem ser dono', async () => {
    const { corpo } = await avaliar({
      subject: { sub: 'u-1', perm: ['*'] },
      resource_type: 'doc',
      resource: { owner_id: 'outro-usuario' },
      action: 'read',
    });
    expect(corpo.effect).toBe('permit');
    expect(corpo.policy_id).not.toBe(idDaPosse);
  });
});

describe('deny-overrides', () => {
  it('deny satisfeito vence um permit satisfeito de maior prioridade', async () => {
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: {
        name: 'permit-amplo',
        effect: 'permit',
        resource_type: 'invoice',
        action: 'read',
        priority: 900,
        condition: { op: 'eq', attr: 'action', value: 'read' },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: {
        name: 'deny-fora-de-horario',
        effect: 'deny',
        resource_type: 'invoice',
        action: 'read',
        priority: 0,
        condition: { op: 'eq', attr: 'resource.confidencial', value: true },
      },
    });

    const permitido = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'invoice',
      resource: { confidencial: false },
      action: 'read',
    });
    expect(permitido.corpo.effect).toBe('permit');

    const negado = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'invoice',
      resource: { confidencial: true },
      action: 'read',
    });
    expect(negado.corpo.effect).toBe('deny');
    expect(negado.corpo.reason).toBe('matched');
  });
});

describe('atributos de ambiente', () => {
  it('avalia janela de horário sobre o `now` informado', async () => {
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: {
        name: 'janela-comercial',
        effect: 'permit',
        resource_type: 'report',
        action: 'read',
        condition: { op: 'lt', attr: 'env.now', value: '2026-08-02T18:00:00Z' },
      },
    });

    const dentro = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'report',
      resource: {},
      action: 'read',
      env: { now: '2026-08-02T10:00:00Z' },
    });
    const fora = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'report',
      resource: {},
      action: 'read',
      env: { now: '2026-08-02T23:00:00Z' },
    });
    expect(dentro.corpo.effect).toBe('permit');
    expect(fora.corpo.effect).toBe('deny');
  });
});

describe('entrada maliciosa', () => {
  it('attr apontando para o protótipo resolve deny e não polui nada', async () => {
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers,
      payload: {
        name: 'tentativa-de-poluicao',
        effect: 'permit',
        resource_type: 'evil',
        action: 'read',
        condition: { op: 'eq', attr: '__proto__.poluido', value: true },
      },
    });

    const { corpo } = await avaliar({
      subject: { sub: 'u-1' },
      resource_type: 'evil',
      resource: {},
      action: 'read',
    });
    expect(corpo.effect).toBe('deny');
    expect(({} as Record<string, unknown>)['poluido']).toBeUndefined();
  });
});
