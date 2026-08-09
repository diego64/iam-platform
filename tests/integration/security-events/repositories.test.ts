/**
 * Os dois repositórios contra um Mongo real: índices, TTL, paginação por cursor e a
 * distinção que separa "insistiu numa conta" de "varreu contas".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import {
  criarRepositorioDeEventosDeSeguranca,
  type RepositorioDeEventosDeSeguranca,
} from '../../../src/modules/security-events/repositories/security-event.repository.js';
import {
  criarRepositorioDeConjuntoDistinto,
  type RepositorioDeConjuntoDistinto,
} from '../../../src/modules/security-events/repositories/distinct-set.repository.js';
import type { Regra } from '../../../src/modules/security-events/constants/regras.js';

const JANELA = 60_000;

let mongo: MongoClient;
let banco: Db;
let eventos: RepositorioDeEventosDeSeguranca;
let conjuntos: RepositorioDeConjuntoDistinto;

function entrada(
  sobrescritas: { regra?: Regra; pista?: string } = {},
): Parameters<RepositorioDeEventosDeSeguranca['anexar']>[0] {
  const agora = new Date();
  return {
    regra: sobrescritas.regra ?? 'brute_force_conta',
    severidade: 'alta',
    sujeito: { tipo: 'conta', pista: sobrescritas.pista ?? 'pista-1' },
    ocorrencias: 12,
    janelaMs: 300_000,
    metadata: { tipo_de_evento: 'iam.auth.login_failed' },
    primeiraEm: agora,
    ultimaEm: agora,
    traceId: 'trace-1',
    expiraEm: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  };
}

beforeAll(async () => {
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  eventos = criarRepositorioDeEventosDeSeguranca(banco);
  conjuntos = criarRepositorioDeConjuntoDistinto({ banco, tamanhoMaximo: 5 });
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('security_events').deleteMany({});
  await banco.collection('security_distinct_sets').deleteMany({});
});

describe('repositório de eventos', () => {
  it('anexa e devolve o evento com id', async () => {
    const evento = await eventos.anexar(entrada());

    expect(evento.id).toMatch(/^[0-9a-f]{24}$/);
    expect(evento.regra).toBe('brute_force_conta');
    expect(evento.detectadoEm).toBeInstanceOf(Date);
  });

  it('busca por id, e id inválido devolve null em vez de estourar', async () => {
    const evento = await eventos.anexar(entrada());

    expect((await eventos.buscarPorId(evento.id))?.id).toBe(evento.id);
    expect(await eventos.buscarPorId('nao-e-um-object-id')).toBeNull();
  });

  it('lista do mais recente para o mais antigo', async () => {
    const primeiro = await eventos.anexar(entrada());
    const segundo = await eventos.anexar(entrada());

    const pagina = await eventos.listar({
      desde: new Date(Date.now() - JANELA),
      ate: new Date(Date.now() + JANELA),
      limite: 10,
    });

    expect(pagina.itens.map((e) => e.id)).toEqual([segundo.id, primeiro.id]);
    expect(pagina.proximoCursor).toBeNull();
  });

  it('filtra por regra e por pista', async () => {
    await eventos.anexar(entrada({ regra: 'brute_force_conta', pista: 'a' }));
    await eventos.anexar(entrada({ regra: 'credential_stuffing', pista: 'b' }));

    const janela = { desde: new Date(Date.now() - JANELA), ate: new Date(Date.now() + JANELA) };
    const porRegra = await eventos.listar({ ...janela, regra: 'credential_stuffing', limite: 10 });
    const porPista = await eventos.listar({ ...janela, pista: 'a', limite: 10 });

    expect(porRegra.itens).toHaveLength(1);
    expect(porRegra.itens[0]?.regra).toBe('credential_stuffing');
    expect(porPista.itens).toHaveLength(1);
    expect(porPista.itens[0]?.sujeito.pista).toBe('a');
  });

  it('respeita o recorte por tempo', async () => {
    await eventos.anexar(entrada());

    const foraDaJanela = await eventos.listar({
      desde: new Date(Date.now() - 2 * JANELA),
      ate: new Date(Date.now() - JANELA),
      limite: 10,
    });

    expect(foraDaJanela.itens).toHaveLength(0);
  });

  it('pagina por cursor sem perder nem repetir', async () => {
    const criados = [];
    for (let i = 0; i < 5; i += 1) {
      criados.push(await eventos.anexar(entrada()));
    }
    const janela = { desde: new Date(Date.now() - JANELA), ate: new Date(Date.now() + JANELA) };

    const primeira = await eventos.listar({ ...janela, limite: 2 });
    const segunda = await eventos.listar({
      ...janela,
      limite: 2,
      cursor: primeira.proximoCursor ?? '',
    });
    const terceira = await eventos.listar({
      ...janela,
      limite: 2,
      cursor: segunda.proximoCursor ?? '',
    });

    const vistos = [...primeira.itens, ...segunda.itens, ...terceira.itens].map((e) => e.id);
    expect(new Set(vistos).size).toBe(5);
    expect(terceira.proximoCursor).toBeNull();
  });

  it('a coleção tem os quatro índices, incluindo o TTL', async () => {
    const indices = await banco.collection('security_events').indexes();

    expect(indices.some((i) => i.key.detectado_em === -1 && i.key.regra === undefined)).toBe(true);
    expect(indices.some((i) => i.key.regra === 1)).toBe(true);
    expect(indices.some((i) => i.key['sujeito.pista'] === 1)).toBe(true);
    expect(indices.some((i) => i.key.expires_at === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});

describe('conjunto distinto', () => {
  it('conta valores distintos, não ocorrências', async () => {
    // É a diferença entre insistir numa conta e varrer contas.
    await conjuntos.registrar('ip:x', 'conta-a', JANELA);
    await conjuntos.registrar('ip:x', 'conta-a', JANELA);
    const tamanho = await conjuntos.registrar('ip:x', 'conta-a', JANELA);

    expect(tamanho).toBe(1);
  });

  it('cresce com valores diferentes', async () => {
    await conjuntos.registrar('ip:y', 'conta-a', JANELA);
    const tamanho = await conjuntos.registrar('ip:y', 'conta-b', JANELA);

    expect(tamanho).toBe(2);
  });

  it('chaves diferentes não se misturam', async () => {
    await conjuntos.registrar('ip:m', 'conta-a', JANELA);

    expect(await conjuntos.registrar('ip:n', 'conta-b', JANELA)).toBe(1);
  });

  it('o teto trava o crescimento e a contagem satura', async () => {
    for (let i = 0; i < 5; i += 1) {
      await conjuntos.registrar('ip:teto', `conta-${String(i)}`, JANELA);
    }

    const saturado = await conjuntos.registrar('ip:teto', 'conta-extra', JANELA);

    expect(saturado).toBe(5);
  });

  it('a janela é fixa: acrescentar não empurra o vencimento', async () => {
    await conjuntos.registrar('ip:janela', 'conta-a', JANELA);
    const primeiro = await banco
      .collection('security_distinct_sets')
      .findOne<{ expires_at: Date }>({ _id: 'ip:janela' as never });

    await conjuntos.registrar('ip:janela', 'conta-b', JANELA);
    const segundo = await banco
      .collection('security_distinct_sets')
      .findOne<{ expires_at: Date }>({ _id: 'ip:janela' as never });

    expect(segundo?.expires_at.getTime()).toBe(primeiro?.expires_at.getTime());
  });

  it('falha de I/O devolve null e avisa, sem lançar', async () => {
    const { cliente: efemero, banco: bancoEfemero } = await conectarMongo(envDeIntegracao());
    await efemero.close();
    const falhas: unknown[] = [];
    const semBanco = criarRepositorioDeConjuntoDistinto({
      banco: bancoEfemero,
      tamanhoMaximo: 5,
      aoFalhar: (erro) => falhas.push(erro),
    });

    await expect(semBanco.registrar('ip:sem-banco', 'conta-a', JANELA)).resolves.toBeNull();
    expect(falhas).toHaveLength(1);
  });

  it('a coleção tem índice TTL', async () => {
    const indices = await banco.collection('security_distinct_sets').indexes();

    expect(indices.some((i) => i.key.expires_at === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });
});
