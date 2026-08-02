/**
 * Cobre o agendador com relógio controlado e serviço de rotação falso: quando ele não age,
 * o ciclo duplo que separa preparar de promover, o desligamento por configuração e o
 * tratamento de erro que não derruba o timer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarAgendadorDeRotacao,
  type AgendadorDeRotacao,
} from '../../../../src/modules/jwks/services/rotation-scheduler.js';
import { ErroDeRotacao } from '../../../../src/modules/jwks/errors/rotation.errors.js';
import type { KeyRotationService } from '../../../../src/modules/jwks/services/key-rotation.service.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';

const IDADE_MAXIMA_MS = 30 * 24 * 60 * 60 * 1000;
const PREPUBLICACAO_MS = 10 * 60 * 1000;
const T0 = 1_800_000_000_000;

const logger = criarLogger({ nivel: 'fatal' });

interface RotacaoFake {
  readonly servico: KeyRotationService;
  readonly prepararProxima: ReturnType<typeof vi.fn>;
  readonly rotacionar: ReturnType<typeof vi.fn>;
  readonly purgar: ReturnType<typeof vi.fn>;
}

/** Serviço de rotação falso: idade da ativa e existência de candidata são parametrizadas. */
function rotacaoFake(opcoes: {
  idadeSegundos: number | null;
  proximaCriadaEm?: number;
  relogio: () => number;
}): RotacaoFake {
  let criadaEm = opcoes.proximaCriadaEm;

  const prepararProxima = vi.fn(() => {
    criadaEm ??= opcoes.relogio();
    return Promise.resolve({
      kid: 'kid-proxima',
      criadaEm: new Date(criadaEm),
      rotacionavelEm: new Date(criadaEm + PREPUBLICACAO_MS),
      criada: true,
    });
  });
  const rotacionar = vi.fn(() =>
    Promise.resolve({
      kidAnterior: 'kid-ativa',
      kidAtivo: 'kid-proxima',
      kidProximo: 'kid-nova',
      verificavelAte: null,
    }),
  );
  const purgar = vi.fn(() => Promise.resolve(0));

  const servico: KeyRotationService = {
    prepararProxima,
    rotacionar,
    purgar,
    revogar: () => Promise.reject(new Error('não usado')),
    idadeDaAtivaEmSegundos: () => Promise.resolve(opcoes.idadeSegundos),
  };

  return { servico, prepararProxima, rotacionar, purgar };
}

let relogio = T0;

function montar(fake: RotacaoFake, extra: { habilitado?: boolean } = {}): AgendadorDeRotacao {
  return criarAgendadorDeRotacao({
    rotacao: fake.servico,
    logger,
    habilitado: extra.habilitado ?? true,
    intervaloMs: 60_000,
    idadeMaximaMs: IDADE_MAXIMA_MS,
    agora: () => relogio,
  });
}

beforeEach(() => {
  relogio = T0;
});

describe('quando o agendador não age', () => {
  it('não rotaciona enquanto a ativa é mais nova que a idade máxima', async () => {
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });

    await montar(fake).executarCiclo();

    expect(fake.rotacionar).not.toHaveBeenCalled();
    expect(fake.prepararProxima).not.toHaveBeenCalled();
  });

  it('não faz nada sem chave ativa — criar a primeira é do bootstrap', async () => {
    const fake = rotacaoFake({ idadeSegundos: null, relogio: () => relogio });

    await montar(fake).executarCiclo();

    expect(fake.rotacionar).not.toHaveBeenCalled();
    expect(fake.prepararProxima).not.toHaveBeenCalled();
  });

  it('desligado por configuração, nem sequer purga', async () => {
    const fake = rotacaoFake({ idadeSegundos: 10 ** 9, relogio: () => relogio });

    await montar(fake, { habilitado: false }).executarCiclo();

    expect(fake.purgar).not.toHaveBeenCalled();
    expect(fake.rotacionar).not.toHaveBeenCalled();
  });

  it('purga a cada ciclo, mesmo sem rotacionar', async () => {
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });

    await montar(fake).executarCiclo();

    expect(fake.purgar).toHaveBeenCalledTimes(1);
  });
});

describe('ciclo duplo — preparar num, promover no seguinte', () => {
  it('com a ativa vencida e sem candidata, o primeiro ciclo só prepara', async () => {
    const fake = rotacaoFake({ idadeSegundos: IDADE_MAXIMA_MS / 1000, relogio: () => relogio });
    const agendador = montar(fake);

    await agendador.executarCiclo();

    expect(fake.prepararProxima).toHaveBeenCalledTimes(1);
    expect(fake.rotacionar).not.toHaveBeenCalled();
  });

  it('o ciclo seguinte promove, depois de a candidata amadurecer', async () => {
    const fake = rotacaoFake({ idadeSegundos: IDADE_MAXIMA_MS / 1000, relogio: () => relogio });
    const agendador = montar(fake);

    await agendador.executarCiclo();
    relogio += PREPUBLICACAO_MS;
    await agendador.executarCiclo();

    expect(fake.rotacionar).toHaveBeenCalledWith({ motivo: 'scheduled' });
  });

  it('promove no mesmo ciclo quando a candidata já estava madura', async () => {
    const fake = rotacaoFake({
      idadeSegundos: IDADE_MAXIMA_MS / 1000,
      proximaCriadaEm: T0 - PREPUBLICACAO_MS,
      relogio: () => relogio,
    });

    await montar(fake).executarCiclo();

    expect(fake.rotacionar).toHaveBeenCalledTimes(1);
  });

  it('não promove faltando um milissegundo para a janela fechar', async () => {
    const fake = rotacaoFake({
      idadeSegundos: IDADE_MAXIMA_MS / 1000,
      proximaCriadaEm: T0 - PREPUBLICACAO_MS + 1,
      relogio: () => relogio,
    });

    await montar(fake).executarCiclo();

    expect(fake.rotacionar).not.toHaveBeenCalled();
  });
});

describe('timer', () => {
  it('iniciar duas vezes não cria dois timers', () => {
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });
    const agendador = montar(fake);
    const espiao = vi.spyOn(global, 'setInterval');

    agendador.iniciar();
    agendador.iniciar();
    agendador.parar();

    expect(espiao).toHaveBeenCalledTimes(1);
    espiao.mockRestore();
  });

  it('desligado por configuração, não agenda timer nenhum', () => {
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });
    const espiao = vi.spyOn(global, 'setInterval');

    const agendador = montar(fake, { habilitado: false });
    agendador.iniciar();

    expect(espiao).not.toHaveBeenCalled();
    espiao.mockRestore();
  });

  it('parar é idempotente', () => {
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });
    const agendador = montar(fake);

    agendador.iniciar();
    agendador.parar();

    expect(() => {
      agendador.parar();
    }).not.toThrow();
  });

  it('erro no ciclo não derruba o timer', async () => {
    vi.useFakeTimers();
    const fake = rotacaoFake({ idadeSegundos: 60, relogio: () => relogio });
    fake.purgar.mockRejectedValueOnce(new ErroDeRotacao('rotacao-em-andamento'));
    const agendador = montar(fake);

    agendador.iniciar();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    agendador.parar();
    vi.useRealTimers();

    // Duas passagens: a primeira falhou, a segunda seguiu normalmente.
    expect(fake.purgar).toHaveBeenCalledTimes(2);
  });
});
