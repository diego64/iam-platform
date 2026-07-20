/**
 * Cobre o repositório de token de reset contra o Mongo real: o token em claro nunca é
 * gravado, o consumo é atômico (só uma corrida vence), e erro no banco propaga para o
 * serviço rejeitar (fail closed — a decisão de rejeitar é do serviço; aqui provamos que o
 * repositório não engole o erro).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import {
  criarRepositorioDeTokenDeReset,
  type RepositorioDeTokenDeReset,
} from '../../../src/modules/password/repositories/reset-token.repository.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

let cliente: MongoClient;
let banco: Db;
let repo: RepositorioDeTokenDeReset;

const COLECAO = 'password_reset_tokens';

function tokenNovo(): string {
  return randomBytes(32).toString('base64url');
}

function daquiA(minutos: number): Date {
  return new Date(Date.now() + minutos * 60_000);
}

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  repo = criarRepositorioDeTokenDeReset(banco);
});

beforeEach(async () => {
  await banco.collection(COLECAO).deleteMany({});
});

afterAll(async () => {
  await banco.collection(COLECAO).deleteMany({});
  await cliente.close();
});

describe('registrar', () => {
  it('grava o sha256, nunca o token em claro', async () => {
    const token = tokenNovo();
    await repo.registrar({ token, userId: 'u1', expiraEm: daquiA(30) });

    const doc = await banco.collection(COLECAO).findOne({ user_id: 'u1' });
    expect(doc?.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));

    // O token em claro não aparece em nenhum campo do documento.
    expect(JSON.stringify(doc)).not.toContain(token);
  });
});

describe('buscarValido', () => {
  it('devolve o dono sem consumir — o token segue usável depois', async () => {
    const token = tokenNovo();
    await repo.registrar({ token, userId: 'u1', expiraEm: daquiA(30) });

    expect(await repo.buscarValido(token)).toEqual({ userId: 'u1' });
    // Não consumiu: ainda dá para consumir de fato.
    expect(await repo.consumir(token)).toEqual({ userId: 'u1' });
  });

  it('devolve null para token inexistente e para expirado', async () => {
    const expirado = tokenNovo();
    await repo.registrar({ token: expirado, userId: 'u1', expiraEm: daquiA(-1) });

    expect(await repo.buscarValido(tokenNovo())).toBeNull();
    expect(await repo.buscarValido(expirado)).toBeNull();
  });
});

describe('consumir', () => {
  it('devolve o dono e marca usado no feliz', async () => {
    const token = tokenNovo();
    await repo.registrar({ token, userId: 'u1', expiraEm: daquiA(30) });

    expect(await repo.consumir(token)).toEqual({ userId: 'u1' });
    // Segundo consumo falha: uso único.
    expect(await repo.consumir(token)).toBeNull();
  });

  it('só uma de duas corridas simultâneas vence', async () => {
    const token = tokenNovo();
    await repo.registrar({ token, userId: 'u1', expiraEm: daquiA(30) });

    const [a, b] = await Promise.all([repo.consumir(token), repo.consumir(token)]);
    const vitorias = [a, b].filter((r) => r !== null);

    expect(vitorias).toHaveLength(1);
  });

  it('token inexistente devolve null', async () => {
    expect(await repo.consumir(tokenNovo())).toBeNull();
  });

  it('token expirado devolve null (mesmo antes da varredura do TTL)', async () => {
    const token = tokenNovo();
    await repo.registrar({ token, userId: 'u1', expiraEm: daquiA(-1) });

    expect(await repo.consumir(token)).toBeNull();
  });

  it('propaga erro do banco em vez de engolir (o serviço fecha na falha)', async () => {
    // Conexão própria e descartável: fechá-la não afeta o cliente compartilhado da suíte.
    const { cliente: descartavel, banco: bancoDescartavel } =
      await conectarMongo(envDeIntegracao());
    const repoMorto = criarRepositorioDeTokenDeReset(bancoDescartavel);
    await descartavel.close();

    await expect(repoMorto.consumir(tokenNovo())).rejects.toBeDefined();
  });
});

describe('invalidarDoUsuario', () => {
  it('remove os tokens pendentes do usuário', async () => {
    const t1 = tokenNovo();
    const t2 = tokenNovo();
    await repo.registrar({ token: t1, userId: 'u1', expiraEm: daquiA(30) });
    await repo.registrar({ token: t2, userId: 'u1', expiraEm: daquiA(30) });

    await repo.invalidarDoUsuario('u1');

    expect(await repo.consumir(t1)).toBeNull();
    expect(await repo.consumir(t2)).toBeNull();
  });
});
