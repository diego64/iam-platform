/**
 * Cobre o defeito que a montagem do processo revela: o `logout` recebia um dublê de refresh
 * token em todos os caminhos, então revogava o access token e deixava o refresh vivo — o
 * par continuava trocável por um access novo depois de o usuário sair.
 *
 * Aqui o app é o de produção, com o serviço real ligado pelo composition root.
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

const EMAIL = 'logout-refresh@iam.local';
const SENHA = 'S3nh@Forte!';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

/** IP novo a cada chamada: o teto do login é por IP e não é o que se mede aqui. */
function proximoIp(): string {
  ip += 1;
  return `10.9.0.${String(ip)}`;
}

async function logar(): Promise<{ accessToken: string; refreshToken: string }> {
  const resposta = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    payload: { email: EMAIL, senha: SENHA },
  });
  const corpo = resposta.json<{ access_token: string; refresh_token: string }>();
  return { accessToken: corpo.access_token, refreshToken: corpo.refresh_token };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('refresh_tokens').deleteMany({});

  app = await montarAppReal({ pool, banco });
  await semearUsuario(pool, EMAIL, SENHA);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('logout revoga o par inteiro', () => {
  it('o refresh token de uma sessão deslogada não vale mais', async () => {
    const { accessToken, refreshToken } = await logar();

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refresh_token: refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: proximoIp(),
      payload: { refresh_token: refreshToken },
    });

    expect(refresh.statusCode).toBe(401);
  });

  it('o access token da sessão deslogada também é recusado', async () => {
    const { accessToken, refreshToken } = await logar();

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refresh_token: refreshToken },
    });
    const eu = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(eu.statusCode).toBe(401);
  });

  it('o refresh de uma sessão que não deslogou continua valendo', async () => {
    const { refreshToken } = await logar();

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: proximoIp(),
      payload: { refresh_token: refreshToken },
    });

    expect(refresh.statusCode).toBe(200);
  });
});
