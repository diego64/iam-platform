/**
 * Cobre a memória de dispositivos contra um Mongo real.
 *
 * O que precisa ser verdade: a primeira aparição avisa e as seguintes não, o vencimento
 * desliza a cada uso, e banco fora do ar **não** notifica — o contrário inundaria a caixa de
 * entrada de todo mundo justo durante um incidente.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import {
  criarRepositorioDeDispositivos,
  type RepositorioDeDispositivos,
} from '../../../src/modules/notifications/repositories/known-device.repository.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const USUARIO = '11111111-1111-4111-8111-111111111111';

let mongo: MongoClient;
let banco: Db;
let repo: RepositorioDeDispositivos;

const NAVEGADOR = { userId: USUARIO, ip: '203.0.113.10', userAgent: 'Mozilla/5.0' };

beforeAll(async () => {
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  repo = criarRepositorioDeDispositivos({ banco, ttlMs: TTL_MS, pepper: PEPPER });
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('known_devices').deleteMany({});
});

describe('ehNovo', () => {
  it('avisa na primeira aparição e cala nas seguintes', async () => {
    expect(await repo.ehNovo(NAVEGADOR)).toBe(true);
    expect(await repo.ehNovo(NAVEGADOR)).toBe(false);
    expect(await repo.ehNovo(NAVEGADOR)).toBe(false);
  });

  it('o vencimento desliza a cada uso', async () => {
    await repo.ehNovo(NAVEGADOR);
    const primeiro = await banco.collection('known_devices').findOne({});

    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.ehNovo(NAVEGADOR);
    const segundo = await banco.collection('known_devices').findOne({});

    // Com janela fixa, quem usa o mesmo navegador todo dia receberia um "novo dispositivo"
    // falso a cada vencimento.
    expect((segundo?.expires_at as Date).getTime()).toBeGreaterThan(
      (primeiro?.expires_at as Date).getTime(),
    );
    expect((segundo?.primeiro_uso as Date).getTime()).toBe(
      (primeiro?.primeiro_uso as Date).getTime(),
    );
  });

  it('outro navegador do mesmo usuário é dispositivo novo', async () => {
    await repo.ehNovo(NAVEGADOR);

    expect(await repo.ehNovo({ ...NAVEGADOR, userAgent: 'curl/8.5.0' })).toBe(true);
  });

  it('outra rede é dispositivo novo', async () => {
    await repo.ehNovo(NAVEGADOR);

    expect(await repo.ehNovo({ ...NAVEGADOR, ip: '198.51.100.10' })).toBe(true);
  });

  it('IP vizinho na mesma rede continua conhecido', async () => {
    await repo.ehNovo(NAVEGADOR);

    // NAT móvel troca o último octeto o tempo todo; avisar por isso é ruído.
    expect(await repo.ehNovo({ ...NAVEGADOR, ip: '203.0.113.250' })).toBe(false);
  });

  it('o mesmo dispositivo de outro usuário é novo para esse outro usuário', async () => {
    await repo.ehNovo(NAVEGADOR);

    expect(
      await repo.ehNovo({ ...NAVEGADOR, userId: '22222222-2222-4222-8222-222222222222' }),
    ).toBe(true);
  });

  it('sem user-agent e sem IP não há dispositivo a distinguir', async () => {
    expect(await repo.ehNovo({ userId: USUARIO, ip: null, userAgent: null })).toBe(false);
    expect(await banco.collection('known_devices').countDocuments()).toBe(0);
  });

  it('guarda só o digest — nem usuário, nem IP, nem user-agent', async () => {
    await repo.ehNovo(NAVEGADOR);
    const documento = await banco.collection('known_devices').findOne({});
    const inteiro = JSON.stringify(documento);

    expect(inteiro).not.toContain(USUARIO);
    expect(inteiro).not.toContain('203.0.113');
    expect(inteiro).not.toContain('Mozilla');
    expect(Object.keys(documento ?? {}).sort()).toEqual([
      '_id',
      'expires_at',
      'primeiro_uso',
      'ultimo_uso',
    ]);
  });

  it('banco fora do ar não notifica, e não lança', async () => {
    const quebrado = criarRepositorioDeDispositivos({
      banco: {
        collection: () => ({ updateOne: () => Promise.reject(new Error('mongo fora')) }),
      } as unknown as Db,
      ttlMs: TTL_MS,
      pepper: PEPPER,
    });

    // Fail closed aqui, ao contrário do resto da plataforma: um `true` transformaria todo
    // login em e-mail justo quando o operador já tem um incidente nas mãos.
    await expect(quebrado.ehNovo(NAVEGADOR)).resolves.toBe(false);
  });

  it('o índice TTL existe na coleção', async () => {
    const indices = await banco.collection('known_devices').indexes();
    const ttl = indices.find((indice) => 'expireAfterSeconds' in indice);

    expect(ttl?.key).toEqual({ expires_at: 1 });
    expect(ttl?.expireAfterSeconds).toBe(0);
  });
});
