/**
 * Fluxo completo da rotação contra o app real e bancos reais — a promessa central da SPEC:
 * rotacionar não derruba quem já tem token.
 *
 * Percurso: emitir token com a chave atual → preparar → promover → provar que o token
 * antigo continua válido e que o novo já sai com outro `kid` → deixar a janela de graça
 * fechar e provar que o antigo passa a ser rejeitado e some do JWKS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { decodeProtectedHeader } from 'jose';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarSchemaJwks } from './schema.js';
import { montarAppDeChaves } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-rotacao@iam.local';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
/** App com graça longa: o token antigo sobrevive à rotação. */
let appComGraca: FastifyInstance;
/** App com graça zero: a chave aposentada para de verificar no ato. */
let appSemGraca: FastifyInstance;
let ip = 0;

function proximoIp(): string {
  ip += 1;
  return `10.12.0.${String(ip % 250)}`;
}

async function logar(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email: ADMIN, senha: SENHA },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ access_token: string }>().access_token;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function prepararERotacionar(app: FastifyInstance, token: string): Promise<void> {
  const preparo = await app.inject({
    method: 'POST',
    url: '/admin/keys/prepare',
    headers: bearer(token),
  });
  expect([200, 201]).toContain(preparo.statusCode);

  const rotacao = await app.inject({
    method: 'POST',
    url: '/admin/keys/rotate',
    headers: bearer(token),
    payload: {},
  });
  expect(rotacao.statusCode).toBe(200);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  const montado = await montarAppDeChaves({ pool, banco, graceMs: 900_000 });
  appComGraca = montado.app;

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [ADMIN, hash]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'superadmin'`,
    [ADMIN],
  );

  // Segundo app sobre o mesmo banco, com graça zero — é assim que a expiração da janela é
  // observável sem esperar quinze minutos.
  appSemGraca = (await montarAppDeChaves({ pool, banco, graceMs: 0 })).app;
});

afterAll(async () => {
  await appComGraca.close();
  await appSemGraca.close();
  await pool.end();
  await cliente.close();
});

describe('rotação sem downtime', () => {
  it('token emitido antes da rotação continua válido depois dela', async () => {
    const token = await logar(appComGraca);
    const antes = await appComGraca.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    expect(antes.statusCode).toBe(200);

    await prepararERotacionar(appComGraca, token);

    const depois = await appComGraca.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    expect(depois.statusCode).toBe(200);
  });

  it('token emitido depois da rotação sai com outro kid', async () => {
    const token = await logar(appComGraca);
    const kidAntes = decodeProtectedHeader(token).kid;

    await prepararERotacionar(appComGraca, token);
    const tokenNovo = await logar(appComGraca);

    expect(decodeProtectedHeader(tokenNovo).kid).not.toBe(kidAntes);
  });

  it('a chave aposentada continua publicada no JWKS durante a graça', async () => {
    const token = await logar(appComGraca);
    const kidAntigo = decodeProtectedHeader(token).kid;

    await prepararERotacionar(appComGraca, token);

    const jwks = await appComGraca.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const kids = jwks.json<{ keys: { kid: string }[] }>().keys.map((k) => k.kid);
    expect(kids).toContain(kidAntigo);
  });

  it('o JWKS nunca publica material privado, nem durante a rotação', async () => {
    const jwks = await appComGraca.inject({ method: 'GET', url: '/.well-known/jwks.json' });

    expect(jwks.body).not.toMatch(/"d"\s*:/);
    expect(jwks.json<{ keys: unknown[] }>().keys.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fim da janela de graça', () => {
  it('passada a graça, o token antigo é rejeitado e o kid some do JWKS', async () => {
    const token = await logar(appSemGraca);
    const kidAntigo = decodeProtectedHeader(token).kid;
    expect(
      (await appSemGraca.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) }))
        .statusCode,
    ).toBe(200);

    // Graça zero: a chave para de verificar no mesmo instante em que é aposentada.
    await prepararERotacionar(appSemGraca, token);

    const depois = await appSemGraca.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    expect(depois.statusCode).toBe(401);

    const jwks = await appSemGraca.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const kids = jwks.json<{ keys: { kid: string }[] }>().keys.map((k) => k.kid);
    expect(kids).not.toContain(kidAntigo);
  });

  it('quem loga depois da rotação segue funcionando normalmente', async () => {
    const token = await logar(appSemGraca);

    const res = await appSemGraca.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });

    expect(res.statusCode).toBe(200);
  });
});
