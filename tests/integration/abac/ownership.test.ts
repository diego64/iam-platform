/**
 * Proving ground de posse: o guard aplicado a um endpoint real. Este é o teste que prova que
 * a primitiva serve para alguma coisa — dono lê o próprio recurso, terceiro autenticado e
 * com a permissão do RBAC recebe 403 mesmo assim, e o inexistente vira 404 sem revelar posse.
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
const DONO = 'dono@iam.local';
const TERCEIRO = 'terceiro@iam.local';
const ADMIN = 'admin-posse@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let idDoDono: string;
let idDoTerceiro: string;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.5.0.${String(ip)}`;
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

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaAbac(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  const montado = await montarAppDeAbac({ pool, banco });
  app = montado.app;

  // `users:read` não está no seed do RBAC (é permissão da SPEC 002): criamos aqui para que
  // o terceiro passe pelo guard grosso e o 403 venha comprovadamente do ABAC.
  await pool.query("INSERT INTO permissions (name) VALUES ('users:read') ON CONFLICT DO NOTHING");
  const { rows: papel } = await pool.query<{ id: string }>(
    `INSERT INTO roles (name) VALUES ('leitor-de-usuarios') RETURNING id`,
  );
  const roleId = papel[0]?.id ?? '';
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE name = 'users:read'`,
    [roleId],
  );

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  async function criar(email: string, superadmin = false): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash],
    );
    const id = rows[0]?.id ?? '';
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, roleId]);
    if (superadmin) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE name = 'superadmin'`,
        [id],
      );
    }
    return id;
  }

  idDoDono = await criar(DONO);
  idDoTerceiro = await criar(TERCEIRO);
  await criar(ADMIN, true);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('leitura do próprio recurso', () => {
  it('o dono lê o próprio perfil (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${idDoDono}`,
      headers: await logar(DONO),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(idDoDono);
  });

  it('terceiro com users:read recebe 403 — o RBAC deixa passar, o ABAC nega', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${idDoDono}`,
      headers: await logar(TERCEIRO),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('authorization-denied');
  });

  it('o terceiro continua lendo o próprio', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${idDoTerceiro}`,
      headers: await logar(TERCEIRO),
    });
    expect(res.statusCode).toBe(200);
  });

  it('o superadmin lê qualquer perfil pelo override de privilégio', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${idDoDono}`,
      headers: await logar(ADMIN),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('bordas do guard', () => {
  it('recurso inexistente ⇒ 404, não 403 — resolvido antes da política', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/00000000-0000-0000-0000-000000000000',
      headers: await logar(TERCEIRO),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toContain('resource-not-found');
  });

  it('sem token ⇒ 401 do middleware de autenticação, não 403 do guard', async () => {
    const res = await app.inject({ method: 'GET', url: `/users/${idDoDono}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('sem política aplicável', () => {
  it('desligar as políticas de sistema fecha o endpoint (fail closed), não abre', async () => {
    const headers = await logar(DONO);
    await pool.query('UPDATE policies SET enabled = false WHERE is_system');
    try {
      // A escrita foi direta no banco (simula outro processo): esperar o TTL do cache é o
      // que o RNF-05 promete, então forçamos a releitura zerando a janela.
      await new Promise((r) => setTimeout(r, 5_100));
      const res = await app.inject({ method: 'GET', url: `/users/${idDoDono}`, headers });
      expect(res.statusCode).toBe(403);
    } finally {
      await pool.query('UPDATE policies SET enabled = true WHERE is_system');
    }
  }, 15_000);
});
