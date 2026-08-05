/**
 * Cobre a verificação de integridade contra as quatro formas de adulteração que ela existe
 * para detectar.
 *
 * A trilha em memória aqui é construída com o mesmo cálculo de elo do serviço real, então
 * "íntegra" significa íntegra de verdade — e cada teste quebra a trilha de um jeito
 * diferente para ver o detector reagir no lugar certo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { criarAuditIntegrityService } from '../../../../src/modules/audit/services/audit-integrity.service.js';
import { calcularHashDoElo } from '../../../../src/modules/audit/services/chain-hash.js';
import { ErroDeAuditoria } from '../../../../src/modules/audit/errors/audit.errors.js';
import { HASH_DE_GENESE } from '../../../../src/modules/audit/types/audit-event.js';
import type { EventoPersistido } from '../../../../src/modules/audit/types/audit-event.js';
import type { RepositorioDaTrilha } from '../../../../src/modules/audit/repositories/audit-log.repository.js';
import type {
  Checkpoint,
  RepositorioDeCheckpoint,
} from '../../../../src/modules/audit/repositories/audit-checkpoint.repository.js';

/** Constrói N eventos encadeados de verdade, do mesmo jeito que o serviço de escrita faria. */
function trilhaIntegra(quantidade: number): EventoPersistido[] {
  const eventos: EventoPersistido[] = [];
  let elo = HASH_DE_GENESE;

  for (let seq = 1; seq <= quantidade; seq += 1) {
    const corpo = {
      eventId: `evt-${String(seq)}`,
      type: 'iam.auth.login' as const,
      occurredAt: new Date(Date.UTC(2026, 7, 3, 12, seq)),
      actor: { id: `u${String(seq)}`, type: 'user' as const },
      target: null,
      outcome: 'success' as const,
      reason: null,
      subjectHint: null,
      metadata: {},
      requestId: null,
      traceId: null,
    };
    const hash = calcularHashDoElo(seq, elo, corpo);
    eventos.push({ ...corpo, seq, prevHash: elo, hash });
    elo = hash;
  }
  return eventos;
}

function repoFake(eventos: EventoPersistido[]): RepositorioDaTrilha {
  const ordenados = [...eventos].sort((a, b) => a.seq - b.seq);
  return {
    garantirGenese: () => Promise.resolve(),
    topo: () => {
      const ultimo = ordenados.at(-1);
      return Promise.resolve(
        ultimo === undefined
          ? { seq: 0, hash: HASH_DE_GENESE }
          : { seq: ultimo.seq, hash: ultimo.hash },
      );
    },
    anexar: () => Promise.reject(new Error('não usado na verificação')),
    buscarPorSeq: (seq) => Promise.resolve(ordenados.find((e) => e.seq === seq) ?? null),
    contarPorTipoDesde: () => Promise.resolve(0),
    ultimosDoUsuario: () => Promise.resolve([]),
    listar: () => Promise.resolve({ itens: [], proximoCursor: null, temMais: false }),
    lerFaixa: (de, ate) => ({
      [Symbol.asyncIterator]: (): AsyncIterator<EventoPersistido> => {
        const faixa = ordenados.filter((e) => e.seq >= de && e.seq <= ate);
        let i = 0;
        return {
          next: () =>
            Promise.resolve(
              i < faixa.length
                ? { done: false, value: faixa[i++] as EventoPersistido }
                : { done: true, value: undefined },
            ),
        };
      },
    }),
  };
}

function checkpointsFake(ancora: Checkpoint | null): RepositorioDeCheckpoint {
  return {
    gravar: () => Promise.resolve(),
    ultimoAte: () => Promise.resolve(ancora),
    ultimo: () => Promise.resolve(ancora),
  };
}

function servico(
  eventos: EventoPersistido[],
  ancora: Checkpoint | null = null,
  janelaMaxima = 50_000,
): ReturnType<typeof criarAuditIntegrityService> {
  return criarAuditIntegrityService({
    trilha: repoFake(eventos),
    checkpoints: checkpointsFake(ancora),
    janelaMaxima,
  });
}

let eventos: EventoPersistido[];

beforeEach(() => {
  eventos = trilhaIntegra(10);
});

describe('trilha íntegra', () => {
  it('aprova a cadeia inteira e conta o que verificou', async () => {
    const relatorio = await servico(eventos).verificar({ de: 1 });

    expect(relatorio.integra).toBe(true);
    expect(relatorio.verificados).toBe(10);
    expect(relatorio.primeiraQuebra).toBeNull();
    expect(relatorio.ate).toBe(10);
  });

  it('aprova uma janela no meio da trilha', async () => {
    const relatorio = await servico(eventos).verificar({ de: 4, ate: 7 });

    expect(relatorio.integra).toBe(true);
    expect(relatorio.verificados).toBe(4);
  });

  it('aprova trilha vazia — não há o que estar errado ainda', async () => {
    const relatorio = await servico([]).verificar({ de: 1 });

    expect(relatorio.integra).toBe(true);
    expect(relatorio.verificados).toBe(0);
  });
});

describe('valor alterado', () => {
  it('acusa hash divergente na posição adulterada', async () => {
    const alterado = eventos.map((evento) =>
      evento.seq === 5 ? { ...evento, metadata: { injetado: 'sim' } } : evento,
    );

    const relatorio = await servico(alterado).verificar({ de: 1 });

    expect(relatorio.integra).toBe(false);
    expect(relatorio.primeiraQuebra).toEqual({ seq: 5, motivo: 'hash-divergente' });
    expect(relatorio.verificados).toBe(4);
  });

  it('acusa a primeira posição alterada, não a última', async () => {
    const alterado = eventos.map((evento) =>
      evento.seq === 3 || evento.seq === 8 ? { ...evento, outcome: 'failure' as const } : evento,
    );

    expect((await servico(alterado).verificar({ de: 1 })).primeiraQuebra?.seq).toBe(3);
  });
});

describe('elo remendado', () => {
  it('acusa elo quebrado quando o prev_hash não bate com o anterior', async () => {
    const remendado = eventos.map((evento) =>
      evento.seq === 6 ? { ...evento, prevHash: 'f'.repeat(64) } : evento,
    );

    const relatorio = await servico(remendado).verificar({ de: 1 });

    expect(relatorio.primeiraQuebra).toEqual({ seq: 6, motivo: 'elo-quebrado' });
  });
});

describe('evento removido', () => {
  it('acusa posição faltante no meio da trilha', async () => {
    const semOSete = eventos.filter((evento) => evento.seq !== 7);

    const relatorio = await servico(semOSete).verificar({ de: 1, ate: 10 });

    expect(relatorio.primeiraQuebra).toEqual({ seq: 7, motivo: 'seq-faltante' });
  });

  it('acusa posição faltante quando o fim da faixa pedida não existe', async () => {
    const relatorio = await servico(trilhaIntegra(4)).verificar({ de: 1, ate: 10 });

    // O topo é 4: a faixa pedida vai além do que existe, e isso não é adulteração.
    expect(relatorio.integra).toBe(true);
    expect(relatorio.verificados).toBe(4);
  });
});

describe('trilha cortada no fim', () => {
  it('acusa divergência quando a âncora aponta além do topo atual', async () => {
    const cortada = eventos.filter((evento) => evento.seq <= 6);
    const ancora: Checkpoint = { seq: 10, hash: 'a'.repeat(64), criadoEm: new Date() };

    const relatorio = await servico(cortada, ancora).verificar({ de: 1 });

    expect(relatorio.integra).toBe(false);
    expect(relatorio.primeiraQuebra).toEqual({ seq: 10, motivo: 'checkpoint-divergente' });
    expect(relatorio.checkpointConferido?.confere).toBe(false);
  });

  it('acusa divergência quando o evento ancorado existe com outro hash', async () => {
    const ancora: Checkpoint = { seq: 5, hash: 'b'.repeat(64), criadoEm: new Date() };

    const relatorio = await servico(eventos, ancora).verificar({ de: 1 });

    expect(relatorio.primeiraQuebra?.motivo).toBe('checkpoint-divergente');
  });

  it('confirma a âncora quando ela bate com a trilha', async () => {
    const quinto = eventos[4];
    expect(quinto).toBeDefined();
    const ancora: Checkpoint = { seq: 5, hash: quinto?.hash ?? '', criadoEm: new Date() };

    const relatorio = await servico(eventos, ancora).verificar({ de: 1 });

    expect(relatorio.integra).toBe(true);
    expect(relatorio.checkpointConferido).toMatchObject({ seq: 5, confere: true });
  });

  it('não inventa conferência quando ainda não há âncora', async () => {
    expect((await servico(eventos).verificar({ de: 1 })).checkpointConferido).toBeNull();
  });
});

describe('teto da janela', () => {
  it('recusa faixa maior que o teto configurado', async () => {
    await expect(servico(eventos, null, 5).verificar({ de: 1, ate: 100 })).rejects.toBeInstanceOf(
      ErroDeAuditoria,
    );
  });

  it('aceita faixa exatamente no teto', async () => {
    await expect(servico(eventos, null, 10).verificar({ de: 1, ate: 10 })).resolves.toMatchObject({
      integra: true,
    });
  });

  it('traduz falha de leitura em erro de trilha indisponível', async () => {
    const quebrado = criarAuditIntegrityService({
      trilha: { ...repoFake(eventos), topo: () => Promise.reject(new Error('mongo fora')) },
      checkpoints: checkpointsFake(null),
      janelaMaxima: 50_000,
    });

    await expect(quebrado.verificar({ de: 1 })).rejects.toMatchObject({
      codigo: 'trilha-indisponivel',
    });
  });
});
