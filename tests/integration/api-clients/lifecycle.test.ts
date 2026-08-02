/**
 * Ciclo de vida completo do cliente contra o app real e bancos reais — o que amarra o
 * registro à autenticação.
 *
 * Percurso: criar pela API → autenticar com o segredo → rotacionar → provar que os dois
 * segredos valem dentro da janela e que só o novo vale depois dela → desabilitar e provar
 * que a autenticação passa a falhar → remover e provar que o identificador fica queimado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { ClientAuthService } from '../../../src/modules/api-clients/index.js';

const SENHA = 'S3nh@Forte!';
const ADMIN = 'admin-ciclo@iam.local';
/** Sobreposição curta: torna o fim da janela observável sem esperar 24 h. */
const SOBREPOSICAO_MS = 800;

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let autenticar: ClientAuthService['autenticar'];
let token: string;
let ip = 0;

function bearer(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function criarClientePelaApi(
  nome: string,
): Promise<{ id: string; client_id: string; client_secret: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clients',
    headers: bearer(),
    payload: { name: nome, scopes: ['orders:read'], grant_types: ['client_credentials'] },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function rotacionar(id: string, overlapSeconds?: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/clients/${id}/secret`,
    headers: bearer(),
    payload: overlapSeconds === undefined ? {} : { overlap_seconds: overlapSeconds },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ client_secret: string }>().client_secret;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await aplicarMetadadosRbac(pool);
  await recriarSchemaJwks(pool);
  await aplicarClientes(pool);
  await pool.query(
    `INSERT INTO permissions (name) VALUES ('orders:read') ON CONFLICT (name) DO NOTHING`,
  );

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('token_denylist').deleteMany({});

  const montado = await montarAppDeClientes({
    pool,
    banco,
    sobreposicaoPadraoMs: SOBREPOSICAO_MS,
    throttleDeUsoMs: 0,
  });
  app = montado.app;
  autenticar = montado.autenticacaoDeCliente.autenticar.bind(montado.autenticacaoDeCliente);

  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [ADMIN, hash]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'superadmin'`,
    [ADMIN],
  );

  ip += 1;
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: `10.14.0.${String(ip)}`,
    payload: { email: ADMIN, senha: SENHA },
  });
  token = login.json<{ access_token: string }>().access_token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('ciclo de vida do cliente de API', () => {
  it('o cliente criado pela API autentica com o segredo entregue', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-basico');

    const autenticado = await autenticar(criado.client_id, criado.client_secret);

    expect(autenticado).toMatchObject({
      clientId: criado.client_id,
      escopos: ['orders:read'],
      grantTypes: ['client_credentials'],
    });
  });

  it('o segredo errado nunca autentica, mesmo com o identificador certo', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-segredo-errado');

    expect(await autenticar(criado.client_id, 'segredo-inventado')).toBeNull();
  });

  // A janela existe para o cliente trocar de credencial durante um deploy, sem um intervalo
  // em que as réplicas antigas já não autenticam.
  it('durante a sobreposição, os dois segredos autenticam', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-sobreposicao');

    const novo = await rotacionar(criado.id);

    expect(await autenticar(criado.client_id, novo)).not.toBeNull();
    expect(await autenticar(criado.client_id, criado.client_secret)).not.toBeNull();
  });

  it('passada a janela, só o segredo novo autentica', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-janela-fecha');
    const novo = await rotacionar(criado.id);

    await new Promise((resolver) => setTimeout(resolver, SOBREPOSICAO_MS + 200));

    expect(await autenticar(criado.client_id, novo)).not.toBeNull();
    expect(await autenticar(criado.client_id, criado.client_secret)).toBeNull();
  });

  it('revogar a sobreposição encerra o segredo anterior na hora', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-revoga-anterior');
    const novo = await rotacionar(criado.id, 3600);

    const res = await app.inject({
      method: 'POST',
      url: `/clients/${criado.id}/secret/revoke-previous`,
      headers: bearer(),
    });

    expect(res.statusCode).toBe(204);
    expect(await autenticar(criado.client_id, criado.client_secret)).toBeNull();
    expect(await autenticar(criado.client_id, novo)).not.toBeNull();
  });

  it('desabilitar o cliente faz a autenticação falhar imediatamente', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-desabilita');

    await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(),
      payload: { status: 'disabled' },
    });

    expect(await autenticar(criado.client_id, criado.client_secret)).toBeNull();
  });

  it('reabilitar volta a autenticar com o mesmo segredo', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-reabilita');
    await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(),
      payload: { status: 'disabled' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(),
      payload: { status: 'active' },
    });

    expect(await autenticar(criado.client_id, criado.client_secret)).not.toBeNull();
  });

  it('remover queima o identificador — nem o segredo certo autentica depois', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-remove');

    await app.inject({
      method: 'DELETE',
      url: `/clients/${criado.id}`,
      headers: bearer(),
    });

    expect(await autenticar(criado.client_id, criado.client_secret)).toBeNull();
  });

  it('a alteração de escopo aparece na autenticação seguinte', async () => {
    await limparClientes(pool);
    await pool.query(
      `INSERT INTO permissions (name) VALUES ('orders:write') ON CONFLICT (name) DO NOTHING`,
    );
    const criado = await criarClientePelaApi('ciclo-escopos');

    await app.inject({
      method: 'PATCH',
      url: `/clients/${criado.id}`,
      headers: bearer(),
      payload: { scopes: ['orders:write'] },
    });

    const autenticado = await autenticar(criado.client_id, criado.client_secret);
    expect(autenticado?.escopos).toEqual(['orders:write']);
  });

  it('o último uso é registrado depois de uma autenticação bem-sucedida', async () => {
    await limparClientes(pool);
    const criado = await criarClientePelaApi('ciclo-ultimo-uso');

    await autenticar(criado.client_id, criado.client_secret);
    // A gravação é disparada sem bloquear a resposta; espera o próximo tique do laço.
    await new Promise((resolver) => setTimeout(resolver, 100));

    const res = await app.inject({
      method: 'GET',
      url: `/clients/${criado.id}`,
      headers: bearer(),
    });
    expect(res.json<{ last_used_at: string | null }>().last_used_at).not.toBeNull();
  });
});
