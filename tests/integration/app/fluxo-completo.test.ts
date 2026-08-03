/**
 * Exercita o app de produção ponta a ponta, atravessando módulos que até aqui só se
 * encontravam dentro de um helper de teste: autenticação emite o token, RBAC concede a
 * permissão, e o token da sessão seguinte já a carrega.
 *
 * Nenhum helper-app de módulo aqui — é `construirModulos` + `construirApp`, a mesma
 * montagem que o `server.ts` faz.
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
import { montarAppReal, semearUsuario } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const EMAIL_ADMIN = 'admin-fluxo@iam.local';
const EMAIL_COMUM = 'comum-fluxo@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let idComum: string;
let ip = 0;

/** IP novo a cada login: o teto do login é por IP e não é o que se mede aqui. */
function proximoIp(): string {
  ip += 1;
  return `10.7.0.${String(ip)}`;
}

async function logar(email: string): Promise<string> {
  const resposta = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email, senha: SENHA },
  });
  expect(resposta.statusCode).toBe(200);
  return resposta.json<{ access_token: string }>().access_token;
}

function comToken(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('refresh_tokens').deleteMany({});

  app = await montarAppReal({ pool, banco });

  const idAdmin = await semearUsuario(pool, EMAIL_ADMIN, SENHA);
  idComum = await semearUsuario(pool, EMAIL_COMUM, SENHA);

  // O superadmin do seed da 0004 é o dono do curinga. Vincular o primeiro admin a ele é
  // bootstrap operacional; aqui a ligação é direta no banco, como no runbook.
  await pool.query(
    "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'superadmin'",
    [idAdmin],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('login e perfil no mesmo processo', () => {
  it('autentica e consulta o próprio perfil sem trocar de app', async () => {
    const token = await logar(EMAIL_ADMIN);

    const eu = await app.inject({ method: 'GET', url: '/auth/me', headers: comToken(token) });

    expect(eu.statusCode).toBe(200);
    expect(eu.json<{ email: string }>().email).toBe(EMAIL_ADMIN);
  });

  it('credencial errada devolve 401 genérico', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: EMAIL_ADMIN, senha: 'S3nh@Errada!' },
    });

    expect(resposta.statusCode).toBe(401);
  });
});

describe('fluxo entre módulos: autenticação → RBAC → token seguinte', () => {
  it('a permissão concedida pelo papel aparece no token da sessão seguinte', async () => {
    const tokenAdmin = await logar(EMAIL_ADMIN);

    // Antes de qualquer papel, o usuário comum não passa do guard de leitura de papéis.
    const antes = await app.inject({
      method: 'GET',
      url: '/roles',
      headers: comToken(await logar(EMAIL_COMUM)),
    });
    expect(antes.statusCode).toBe(403);

    const papel = await app.inject({
      method: 'POST',
      url: '/roles',
      headers: comToken(tokenAdmin),
      payload: { name: 'leitor-de-papeis' },
    });
    expect(papel.statusCode).toBe(201);
    const idDoPapel = papel.json<{ id: string }>().id;

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM permissions WHERE name = 'roles:read'",
    );
    const idDaPermissao = rows[0]?.id ?? '';

    const vinculo = await app.inject({
      method: 'POST',
      url: `/roles/${idDoPapel}/permissions`,
      headers: comToken(tokenAdmin),
      payload: { permission_ids: [idDaPermissao] },
    });
    expect(vinculo.statusCode).toBe(204);

    const atribuicao = await app.inject({
      method: 'POST',
      url: `/users/${idComum}/roles`,
      headers: comToken(tokenAdmin),
      payload: { role_ids: [idDoPapel] },
    });
    expect(atribuicao.statusCode).toBe(204);

    // O token anterior não muda — a permissão só entra na próxima emissão.
    const depois = await app.inject({
      method: 'GET',
      url: '/roles',
      headers: comToken(await logar(EMAIL_COMUM)),
    });

    expect(depois.statusCode).toBe(200);
  });
});

describe('rotas administrativas de usuário no app real', () => {
  it('o superadmin lista usuários', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/users',
      headers: comToken(await logar(EMAIL_ADMIN)),
    });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json<{ total: number }>().total).toBeGreaterThanOrEqual(2);
  });

  // O autorizador do módulo de usuário exige permissão de escrita; o curinga do superadmin
  // a satisfaz, e um usuário sem papel nenhum não.
  it('usuário sem permissão recebe 403, não 401', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/users',
      headers: comToken(await logar(EMAIL_COMUM)),
    });

    expect(resposta.statusCode).toBe(403);
  });
});
