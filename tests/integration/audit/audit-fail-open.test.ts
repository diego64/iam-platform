/**
 * Prova as duas garantias que a trilha faz ao resto do sistema.
 *
 * A primeira: trilha fora não derruba o login. O evento se perde — vira log de fallback —,
 * mas a operação que o gerou responde normalmente. É a decisão de não trocar um problema de
 * observação por um de negócio, e só um teste com a escrita realmente quebrada a comprova.
 *
 * A segunda: nada do que a trilha guarda é segredo. A varredura roda sobre os documentos
 * gravados por um fluxo real, não sobre um evento montado à mão.
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
import { recriarCheckpoints } from './schema.js';
import { montarAppDeAuditoria } from './helper-app.js';

const SENHA = 'S3nh@Forte!';
const EMAIL = 'sem-trilha@iam.local';

/** Chaves que não podem existir em documento nenhum da trilha. */
const PROIBIDAS = ['senha', 'password', 'token', 'secret', 'hash_senha', 'password_hash'];

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let clienteDaTrilha: MongoClient;
let appSemTrilha: FastifyInstance;
let appNormal: FastifyInstance;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste() });
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);
  await recriarCheckpoints(pool);
  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});

  // Conexão dedicada à trilha, fechada logo em seguida: o app segue com denylist e usuários
  // funcionando, e só a escrita de auditoria está fora — que é o cenário a testar.
  const dedicada = await conectarMongo(envDeIntegracao());
  clienteDaTrilha = dedicada.cliente;
  ({ app: appSemTrilha } = await montarAppDeAuditoria({
    pool,
    banco,
    bancoDaTrilha: dedicada.banco,
  }));

  const montado = await montarAppDeAuditoria({ pool, banco });
  appNormal = montado.app;
  const hash = await montado.servicoDeSenha.gerarHash(SENHA);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [EMAIL, hash]);

  await clienteDaTrilha.close();
}, 60_000);

afterAll(async () => {
  await appSemTrilha.close();
  await appNormal.close();
  await cliente.close();
  await pool.end();
});

describe('trilha indisponível', () => {
  it('o login responde 200 mesmo sem conseguir gravar o evento', async () => {
    const res = await appSemTrilha.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.8.0.1',
      payload: { email: EMAIL, senha: SENHA },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ access_token: string }>().access_token).toBeTruthy();
  });

  it('e o evento realmente não foi gravado — o sucesso não é ilusão do teste', async () => {
    expect(await banco.collection('audit_log').countDocuments({})).toBe(0);
  });
});

describe('nenhum segredo na trilha', () => {
  it('o fluxo real de login não deixa chave sensível em documento nenhum', async () => {
    await appNormal.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.8.0.2',
      payload: { email: EMAIL, senha: SENHA },
    });
    await appNormal.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '10.8.0.3',
      payload: { email: 'ninguem@iam.local', senha: 'ErradaMesmo!1' },
    });

    const documentos = await banco.collection('audit_log').find({}).toArray();
    expect(documentos.length).toBeGreaterThan(0);

    for (const documento of documentos) {
      const chaves = JSON.stringify(Object.keys(documento)).toLowerCase();
      for (const proibida of PROIBIDAS) {
        expect(chaves).not.toContain(proibida);
      }
      // O corpo inteiro também não pode conter a senha nem o e-mail de quem não é usuário.
      const corpo = JSON.stringify(documento);
      expect(corpo).not.toContain(SENHA);
      expect(corpo).not.toContain('ninguem@iam.local');
    }
  });
});
