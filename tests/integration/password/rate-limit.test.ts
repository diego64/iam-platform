/**
 * Cobre o rate limit das rotas de senha: estourado o teto por janela, a rota responde 429
 * com `Retry-After`, sem chegar a executar o fluxo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MongoClient, Db } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { criarRepositorioDeUsuarioFake } from '../../mocks/senha.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { montarAppDeSenha } from './helper-app.js';
import { LIMITE_FORGOT } from '../../../src/modules/password/hooks/password-rate-limit.js';

let cliente: MongoClient;
let banco: Db;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });

  ({ app } = await montarAppDeSenha({ banco, pool, usuarios: criarRepositorioDeUsuarioFake() }));
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await cliente.close();
});

describe('rate limit de /auth/password/forgot', () => {
  it('bloqueia com 429 e Retry-After ao passar do teto da janela', async () => {
    // Uma requisição a mais que o teto: as primeiras passam (202), a excedente é barrada.
    const respostas = [];
    for (let n = 0; n <= LIMITE_FORGOT.max; n += 1) {
      respostas.push(
        await app.inject({
          method: 'POST',
          url: '/auth/password/forgot',
          payload: { email: 'x@iam.local' },
        }),
      );
    }

    const barrada = respostas.at(-1);
    expect(respostas.slice(0, LIMITE_FORGOT.max).every((r) => r.statusCode === 202)).toBe(true);
    expect(barrada?.statusCode).toBe(429);
    expect(barrada?.headers['retry-after']).toBeDefined();
  });
});
