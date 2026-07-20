/**
 * Cobre o encerramento gracioso: ordem de fechamento, reentrância por sinal repetido,
 * estouro do timeout e falha no meio da sequência.
 */
import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { criarEncerrador, type RecursosDeEncerramento } from '../../../src/bootstrap/shutdown.js';
import { criarLogger } from '../../../src/shared/logger/index.js';

/** Logger silencioso — a saída não interessa nestes testes. */
function loggerMudo(): ReturnType<typeof criarLogger> {
  const destino = new Writable({
    write(_pedaco, _codificacao, callback): void {
      callback();
    },
  });
  return criarLogger({ nivel: 'fatal', destino });
}

interface Cenario {
  readonly recursos: RecursosDeEncerramento;
  readonly ordem: string[];
  readonly saidas: number[];
}

function montarCenario(sobrescritas: Partial<RecursosDeEncerramento> = {}): Cenario {
  const ordem: string[] = [];
  const saidas: number[] = [];

  const recursos: RecursosDeEncerramento = {
    app: {
      close: vi.fn(async () => {
        ordem.push('app');
        return Promise.resolve();
      }),
    },
    pool: {
      end: vi.fn(async () => {
        ordem.push('pool');
        return Promise.resolve();
      }),
    },
    mongo: {
      close: vi.fn(async () => {
        ordem.push('mongo');
        return Promise.resolve();
      }),
    },
    logger: loggerMudo(),
    timeoutMs: 10_000,
    encerrarProcesso: (codigo) => saidas.push(codigo),
    ...sobrescritas,
  };

  return { recursos, ordem, saidas };
}

describe('criarEncerrador — caminho feliz', () => {
  it('fecha app, pool e mongo nessa ordem', async () => {
    const { recursos, ordem } = montarCenario();

    await criarEncerrador(recursos)('SIGTERM');

    expect(ordem).toEqual(['app', 'pool', 'mongo']);
  });

  it('sai com código 0', async () => {
    const { recursos, saidas } = montarCenario();

    await criarEncerrador(recursos)('SIGTERM');

    expect(saidas).toEqual([0]);
  });
});

describe('criarEncerrador — sinalização de indisponibilidade', () => {
  it('avisa o readiness ANTES de fechar o servidor', async () => {
    const { recursos, ordem } = montarCenario();

    await criarEncerrador({
      ...recursos,
      // Registra na MESMA trilha dos fechamentos: arrays separados não comparariam
      // ordem, e a ordem é exatamente o que este teste precisa provar.
      aoIniciarEncerramento: () => ordem.push('readiness'),
    })('SIGTERM');

    // Marcar depois do app.close() deixaria o balanceador enviando tráfego novo durante
    // todo o dreno, para um processo que já está desligando.
    expect(ordem).toEqual(['readiness', 'app', 'pool', 'mongo']);
  });

  it('funciona sem o gancho, que é opcional', async () => {
    const { recursos, saidas } = montarCenario();

    await criarEncerrador(recursos)('SIGTERM');

    expect(saidas).toEqual([0]);
  });
});

describe('criarEncerrador — reentrância', () => {
  it('ignora sinal repetido em vez de reiniciar a sequência', async () => {
    const { recursos, ordem, saidas } = montarCenario();
    const encerrar = criarEncerrador(recursos);

    await Promise.all([encerrar('SIGTERM'), encerrar('SIGTERM'), encerrar('SIGINT')]);

    expect(ordem).toEqual(['app', 'pool', 'mongo']);
    expect(saidas).toEqual([0]);
    // `ordem` já prova a execução única; a asserção sobre o mock evita unbound-method.
    expect(ordem.filter((passo) => passo === 'app')).toHaveLength(1);
  });
});

describe('criarEncerrador — timeout duro', () => {
  it('sai com código 1 quando app.close não resolve dentro do timeout', async () => {
    vi.useFakeTimers();
    const { recursos, saidas } = montarCenario({
      app: {
        close: vi.fn(
          () =>
            new Promise<void>(() => {
              /* nunca resolve */
            }),
        ),
      },
      timeoutMs: 1_000,
    });

    void criarEncerrador(recursos)('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saidas).toEqual([1]);
    vi.useRealTimers();
  });

  it('não dispara o timeout quando a sequência conclui a tempo', async () => {
    vi.useFakeTimers();
    const { recursos, saidas } = montarCenario({ timeoutMs: 1_000 });

    await criarEncerrador(recursos)('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(saidas).toEqual([0]);
    vi.useRealTimers();
  });
});

describe('criarEncerrador — falha no meio da sequência', () => {
  it('sai com código 1 quando o fechamento do pool falha', async () => {
    const { recursos, saidas, ordem } = montarCenario({
      pool: { end: vi.fn(() => Promise.reject(new Error('pool travado'))) },
    });

    await criarEncerrador(recursos)('SIGTERM');

    expect(ordem).toEqual(['app']);
    expect(saidas).toEqual([1]);
  });
});
