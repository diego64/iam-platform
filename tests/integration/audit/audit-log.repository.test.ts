/**
 * Cobre a trilha encadeada contra um MongoDB real: gênese idempotente, elo entre eventos
 * consecutivos, paginação por cursor e leitura de faixa.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import {
  criarRepositorioDaTrilha,
  type EventoParaAnexar,
  type RepositorioDaTrilha,
} from '../../../src/modules/audit/repositories/audit-log.repository.js';
import { HASH_DE_GENESE } from '../../../src/modules/audit/types/audit-event.js';
import type { TipoDeEvento } from '../../../src/modules/audit/constants/event-types.js';

let cliente: MongoClient;
let banco: Db;
let repo: RepositorioDaTrilha;

function evento(sobrescritas: Partial<EventoParaAnexar> = {}): EventoParaAnexar {
  return {
    eventId: `evt-${String(Math.random()).slice(2)}`,
    type: 'iam.auth.login',
    occurredAt: new Date('2026-08-03T12:00:00.000Z'),
    actor: { id: 'u1', type: 'user', ip: '203.0.113.10' },
    target: null,
    outcome: 'success',
    reason: null,
    subjectHint: null,
    metadata: {},
    requestId: null,
    traceId: null,
    ...sobrescritas,
  };
}

/** Hash de teste: só precisa depender de seq e do elo anterior. */
function hashDe(seq: number, prevHash: string): string {
  return createHash('sha256')
    .update(`${String(seq)}:${prevHash}`)
    .digest('hex');
}

beforeAll(async () => {
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  repo = criarRepositorioDaTrilha(banco, { maxTentativas: 5 });
});

beforeEach(async () => {
  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});
  await repo.garantirGenese();
});

afterAll(async () => {
  await cliente.close();
});

describe('garantirGenese', () => {
  it('cria o topo em zero com o hash de gênese', async () => {
    expect(await repo.topo()).toEqual({ seq: 0, hash: HASH_DE_GENESE });
  });

  it('roda duas vezes sem alterar um topo já avançado', async () => {
    await repo.anexar(evento(), hashDe);

    await repo.garantirGenese();

    expect((await repo.topo()).seq).toBe(1);
  });
});

describe('anexar', () => {
  it('numera a partir de 1 e encadeia o primeiro evento na gênese', async () => {
    const { evento: primeiro, tentativas } = await repo.anexar(evento(), hashDe);

    expect(primeiro.seq).toBe(1);
    expect(primeiro.prevHash).toBe(HASH_DE_GENESE);
    expect(primeiro.hash).toBe(hashDe(1, HASH_DE_GENESE));
    expect(tentativas).toBe(1);
  });

  it('encadeia três eventos consecutivos, cada um no hash do anterior', async () => {
    const a = await repo.anexar(evento(), hashDe);
    const b = await repo.anexar(evento(), hashDe);
    const c = await repo.anexar(evento(), hashDe);

    expect([a.evento.seq, b.evento.seq, c.evento.seq]).toEqual([1, 2, 3]);
    expect(b.evento.prevHash).toBe(a.evento.hash);
    expect(c.evento.prevHash).toBe(b.evento.hash);
    expect(await repo.topo()).toEqual({ seq: 3, hash: c.evento.hash });
  });

  it('persiste ator, alvo, motivo e metadata como foram entregues', async () => {
    await repo.anexar(
      evento({
        type: 'iam.role.assigned',
        actor: { id: 'admin-1', type: 'user', ip: '198.51.100.7', userAgent: 'curl/8.6.0' },
        target: { id: 'alvo-1', type: 'user' },
        reason: 'admin_action',
        metadata: { role_ids: ['r1', 'r2'] },
        requestId: 'req-1',
        traceId: 'trace-1',
      }),
      hashDe,
    );

    const lido = await repo.buscarPorSeq(1);
    expect(lido?.actor).toEqual({
      id: 'admin-1',
      type: 'user',
      ip: '198.51.100.7',
      userAgent: 'curl/8.6.0',
    });
    expect(lido?.target).toEqual({ id: 'alvo-1', type: 'user' });
    expect(lido?.reason).toBe('admin_action');
    expect(lido?.metadata).toEqual({ role_ids: ['r1', 'r2'] });
    expect(lido?.requestId).toBe('req-1');
    expect(lido?.traceId).toBe('trace-1');
  });

  it('cria a gênese sozinho quando o topo ainda não existe', async () => {
    await banco.collection('audit_chain_head').deleteMany({});

    const { evento: primeiro } = await repo.anexar(evento(), hashDe);

    expect(primeiro.seq).toBe(1);
  });
});

describe('listar', () => {
  const tipos: TipoDeEvento[] = [
    'iam.auth.login',
    'iam.auth.login_failed',
    'iam.auth.login',
    'iam.user.created',
    'iam.auth.login',
  ];

  beforeEach(async () => {
    for (const [indice, type] of tipos.entries()) {
      await repo.anexar(
        evento({
          type,
          occurredAt: new Date(Date.UTC(2026, 7, 3, 12, indice)),
          actor: { id: indice % 2 === 0 ? 'u1' : 'u2', type: 'user' },
          outcome: type === 'iam.auth.login_failed' ? 'failure' : 'success',
        }),
        hashDe,
      );
    }
  });

  it('filtra por tipo', async () => {
    const pagina = await repo.listar({ type: 'iam.auth.login', limite: 50 });

    expect(pagina.itens.map((item) => item.seq)).toEqual([1, 3, 5]);
    expect(pagina.temMais).toBe(false);
    expect(pagina.proximoCursor).toBeNull();
  });

  it('filtra por ator e por resultado', async () => {
    expect((await repo.listar({ actorId: 'u2', limite: 50 })).itens).toHaveLength(2);
    expect((await repo.listar({ outcome: 'failure', limite: 50 })).itens).toHaveLength(1);
  });

  it('filtra por janela de tempo, com o fim exclusivo', async () => {
    const pagina = await repo.listar({
      de: new Date(Date.UTC(2026, 7, 3, 12, 1)),
      ate: new Date(Date.UTC(2026, 7, 3, 12, 3)),
      limite: 50,
    });

    expect(pagina.itens.map((item) => item.seq)).toEqual([2, 3]);
  });

  it('pagina por cursor sem repetir nem pular evento', async () => {
    const primeira = await repo.listar({ limite: 2 });
    expect(primeira.itens.map((item) => item.seq)).toEqual([1, 2]);
    expect(primeira.temMais).toBe(true);
    expect(primeira.proximoCursor).toBe(3);

    const segunda = await repo.listar({ limite: 2, cursor: primeira.proximoCursor ?? 0 });
    expect(segunda.itens.map((item) => item.seq)).toEqual([3, 4]);

    const terceira = await repo.listar({ limite: 2, cursor: segunda.proximoCursor ?? 0 });
    expect(terceira.itens.map((item) => item.seq)).toEqual([5]);
    expect(terceira.temMais).toBe(false);
    expect(terceira.proximoCursor).toBeNull();
  });
});

describe('lerFaixa', () => {
  it('percorre a faixa em ordem de posição, com as duas pontas inclusivas', async () => {
    for (let i = 0; i < 5; i += 1) await repo.anexar(evento(), hashDe);

    const posicoes: number[] = [];
    for await (const item of repo.lerFaixa(2, 4)) posicoes.push(item.seq);

    expect(posicoes).toEqual([2, 3, 4]);
  });
});
