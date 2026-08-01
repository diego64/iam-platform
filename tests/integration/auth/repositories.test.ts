/**
 * Cobre os repositórios de autenticação contra bancos reais: busca de usuário por e-mail e
 * papéis (PostgreSQL) e a denylist idempotente com índice TTL (MongoDB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { MongoClient, Db } from 'mongodb';
import {
  criarRepositorioDeAutenticacao,
  type RepositorioDeAutenticacao,
} from '../../../src/modules/auth/repositories/auth-user.repository.js';
import {
  criarRepositorioDeDenylist,
  type RepositorioDeDenylist,
} from '../../../src/modules/auth/repositories/token-denylist.repository.js';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let repo: RepositorioDeAutenticacao;
let denylist: RepositorioDeDenylist;

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchema(pool);
  repo = criarRepositorioDeAutenticacao(pool);

  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  denylist = criarRepositorioDeDenylist(banco);
});

afterAll(async () => {
  await pool.end();
  await cliente.close();
});

describe('RepositorioDeAutenticacao (PostgreSQL)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE users, roles, user_roles CASCADE');
  });

  it('busca o usuário por e-mail com hash e status', async () => {
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
      'a@iam.local',
      HASH,
    ]);

    const usuario = await repo.buscarPorEmail('a@iam.local');
    expect(usuario).toMatchObject({ email: 'a@iam.local', status: 'active', passwordHash: HASH });
    expect(await repo.buscarPorEmail('nao@existe.local')).toBeNull();
  });

  it('carrega os papéis do usuário em ordem', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['b@iam.local', HASH],
    );
    const userId = rows[0]?.id ?? '';
    await pool.query("INSERT INTO roles (name) VALUES ('admin'), ('auditor')");
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name IN ('admin', 'auditor')`,
      [userId],
    );

    expect(await repo.papeisDoUsuario(userId)).toEqual(['admin', 'auditor']);
  });

  it('devolve lista vazia para usuário sem papéis', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      ['c@iam.local', HASH],
    );
    expect(await repo.papeisDoUsuario(rows[0]?.id ?? '')).toEqual([]);
  });
});

describe('RepositorioDeDenylist (MongoDB)', () => {
  beforeEach(async () => {
    await banco.collection('token_denylist').deleteMany({});
  });

  it('revoga um jti e passa a reportá-lo como revogado', async () => {
    const jti = '0193b6e2-7f00-7cd1-9a3e-2b7c9f0a1d42';
    expect(await denylist.estaRevogado(jti)).toBe(false);

    await denylist.revogar({
      jti,
      userId: 'u1',
      motivo: 'logout',
      expiraEm: new Date(Date.now() + 60_000),
    });
    expect(await denylist.estaRevogado(jti)).toBe(true);
  });

  it('é idempotente: revogar o mesmo jti duas vezes não falha', async () => {
    const jti = '0193b6e2-7f00-7cd1-9a3e-2b7c9f0a1d99';
    const entrada = {
      jti,
      userId: 'u1',
      motivo: 'logout' as const,
      expiraEm: new Date(Date.now() + 60_000),
    };
    await denylist.revogar(entrada);
    await expect(denylist.revogar(entrada)).resolves.toBeUndefined();
    expect(await banco.collection('token_denylist').countDocuments({ jti })).toBe(1);
  });

  it('a coleção tem índice TTL em expires_at', async () => {
    const indices = await banco.collection('token_denylist').indexes();
    const ttl = indices.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl?.key).toMatchObject({ expires_at: 1 });
  });
});
