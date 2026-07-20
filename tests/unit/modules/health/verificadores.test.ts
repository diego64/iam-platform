/**
 * Cobre os verificadores de dependência.
 *
 * Dois invariantes que valem mais que os demais:
 *  - nunca lançam, porque exceção não tratada viraria 500 e o orquestrador concluiria
 *    "fora" sem diagnóstico;
 *  - nunca deixam a mensagem do driver escapar, porque ela traz host e usuário e a
 *    resposta de /health/ready é pública.
 */
import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import {
  criarVerificadorMongo,
  criarVerificadorPostgres,
} from '../../../../src/modules/health/services/verificadores.js';

const TETO = 200;

/** Pool falso: `comportamento` decide o desfecho da consulta. */
function poolFalso(comportamento: 'ok' | 'recusa' | 'trava' | 'erro_estranho'): Pool {
  return {
    query: async () => {
      if (comportamento === 'recusa') throw new Error('connection refused');
      if (comportamento === 'erro_estranho') {
        // Lançar não-Error é o objeto deste caso: código de terceiro faz isso, e o
        // verificador precisa classificar como erro_interno em vez de estourar.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'algo que não é Error';
      }
      if (comportamento === 'trava')
        return new Promise(() => {
          /* nunca resolve */
        });
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    },
  } as unknown as Pool;
}

function bancoFalso(comportamento: 'ok' | 'recusa' | 'trava'): Db {
  return {
    admin: () => ({
      command: async () => {
        if (comportamento === 'recusa') throw new Error('MongoServerSelectionError');
        if (comportamento === 'trava')
          return new Promise(() => {
            /* nunca resolve */
          });
        return Promise.resolve({ ok: 1 });
      },
    }),
  } as unknown as Db;
}

describe('verificador do PostgreSQL', () => {
  it('devolve up com duração quando a consulta responde', async () => {
    const estado = await criarVerificadorPostgres(poolFalso('ok'), TETO)();

    expect(estado.nome).toBe('postgres');
    expect(estado.estado).toBe('up');
    expect(estado.duracao_ms).toBeGreaterThanOrEqual(0);
    expect(estado.motivo).toBeUndefined();
  });

  it('devolve down com motivo indisponivel quando a conexão é recusada', async () => {
    const estado = await criarVerificadorPostgres(poolFalso('recusa'), TETO)();

    expect(estado.estado).toBe('down');
    expect(estado.motivo).toBe('indisponivel');
  });

  it('devolve down com motivo timeout quando a dependência TRAVA', async () => {
    const inicio = Date.now();
    const estado = await criarVerificadorPostgres(poolFalso('trava'), TETO)();

    // Travar é diferente de recusar: recusa é instantânea e nunca exercita o teto.
    // É a dependência que aceita e não responde que penduraria a sonda.
    expect(estado.estado).toBe('down');
    expect(estado.motivo).toBe('timeout');
    expect(Date.now() - inicio).toBeLessThan(TETO * 4);
  });

  it('devolve down com erro_interno quando o que foi lançado não é Error', async () => {
    const estado = await criarVerificadorPostgres(poolFalso('erro_estranho'), TETO)();

    expect(estado.estado).toBe('down');
    expect(estado.motivo).toBe('erro_interno');
  });

  it('nunca lança, qualquer que seja o desfecho', async () => {
    for (const caso of ['ok', 'recusa', 'trava', 'erro_estranho'] as const) {
      await expect(criarVerificadorPostgres(poolFalso(caso), TETO)()).resolves.toBeDefined();
    }
  });
});

describe('verificador do MongoDB', () => {
  it('devolve up quando o ping responde', async () => {
    const estado = await criarVerificadorMongo(bancoFalso('ok'), TETO)();

    expect(estado.nome).toBe('mongodb');
    expect(estado.estado).toBe('up');
  });

  it('devolve down com indisponivel quando o servidor não é alcançado', async () => {
    const estado = await criarVerificadorMongo(bancoFalso('recusa'), TETO)();

    expect(estado.estado).toBe('down');
    expect(estado.motivo).toBe('indisponivel');
  });

  it('devolve down com timeout quando trava', async () => {
    const estado = await criarVerificadorMongo(bancoFalso('trava'), TETO)();

    expect(estado.estado).toBe('down');
    expect(estado.motivo).toBe('timeout');
  });
});

describe('nada do driver escapa', () => {
  it('o motivo é sempre uma das três categorias fixas', async () => {
    const categorias = ['timeout', 'indisponivel', 'erro_interno'];

    for (const caso of ['recusa', 'trava', 'erro_estranho'] as const) {
      const estado = await criarVerificadorPostgres(poolFalso(caso), TETO)();
      expect(categorias).toContain(estado.motivo);
    }
  });

  it('o estado não carrega mensagem, stack nem qualquer campo extra', async () => {
    const estado = await criarVerificadorPostgres(poolFalso('recusa'), TETO)();

    // A mensagem do driver traz host, porta e usuário. Se ela couber em algum campo
    // aqui, vaza numa resposta pública e sem autenticação.
    expect(Object.keys(estado).sort()).toEqual(['duracao_ms', 'estado', 'motivo', 'nome']);
    expect(JSON.stringify(estado)).not.toContain('connection refused');
  });
});
