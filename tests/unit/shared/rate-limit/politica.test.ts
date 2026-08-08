/**
 * Cobre a política: teto respeitado, `Retry-After` arredondado para cima, e o fail open —
 * contador devolvendo `null` **e** contador lançando produzem o mesmo efeito, porque a rota
 * não pode virar 500 por causa do rate limit.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  criarPoliticaDeRateLimit,
  type ConsultaDeLimite,
} from '../../../../src/shared/rate-limit/politica.js';
import type {
  ContadorDeRateLimit,
  EstadoDaJanela,
} from '../../../../src/shared/rate-limit/types.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const AGORA = 1_000_000;

const CONSULTA: ConsultaDeLimite = {
  dimensao: 'conta',
  valor: 'admin@iam.local',
  teto: 10,
  janelaMs: 60_000,
  rota: '/auth/login',
};

function montar(contador: Partial<ContadorDeRateLimit>): {
  politica: ReturnType<typeof criarPoliticaDeRateLimit>;
  medidor: {
    contarBloqueio: ReturnType<typeof vi.fn>;
    contarErroDoContador: ReturnType<typeof vi.fn>;
    observarDuracao: ReturnType<typeof vi.fn>;
  };
  aoFalhar: ReturnType<typeof vi.fn>;
} {
  const medidor = {
    contarBloqueio: vi.fn(),
    contarErroDoContador: vi.fn(),
    observarDuracao: vi.fn(),
  };
  const aoFalhar = vi.fn();

  return {
    politica: criarPoliticaDeRateLimit({
      contador: {
        ler: () => Promise.resolve({ contagem: 0, expiraEm: new Date(AGORA) }),
        incrementar: () => Promise.resolve({ contagem: 1, expiraEm: new Date(AGORA) }),
        ...contador,
      },
      pepper: PEPPER,
      medidor,
      aoFalhar,
      agora: () => AGORA,
    }),
    medidor,
    aoFalhar,
  };
}

function estado(contagem: number, expiraEmMs = AGORA + 30_000): EstadoDaJanela {
  return { contagem, expiraEm: new Date(expiraEmMs) };
}

describe('verificar', () => {
  it('abaixo do teto permite e informa o restante', async () => {
    const { politica } = montar({ ler: () => Promise.resolve(estado(3)) });

    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({
      permitido: true,
      limite: 10,
      restante: 7,
      retryAfterSegundos: 0,
    });
  });

  it('no teto barra', async () => {
    // Exatamente no teto já barra: a décima tentativa é a que fecha a cota.
    const { politica, medidor } = montar({ ler: () => Promise.resolve(estado(10)) });

    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({
      permitido: false,
      restante: 0,
    });
    expect(medidor.contarBloqueio).toHaveBeenCalledWith('/auth/login', 'conta');
  });

  it('Retry-After é o restante da janela arredondado para cima', async () => {
    const { politica } = montar({ ler: () => Promise.resolve(estado(10, AGORA + 30_400)) });

    // 30,4 s viram 31: arredondar para baixo convidaria a tentar antes da hora.
    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({
      retryAfterSegundos: 31,
    });
  });

  it('Retry-After nunca é zero', async () => {
    const { politica } = montar({ ler: () => Promise.resolve(estado(10, AGORA)) });

    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({
      retryAfterSegundos: 1,
    });
  });

  it('contador indisponível deixa passar e conta o erro', async () => {
    const { politica, medidor, aoFalhar } = montar({ ler: () => Promise.resolve(null) });

    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({ permitido: true });
    expect(medidor.contarErroDoContador).toHaveBeenCalledOnce();
    expect(aoFalhar).toHaveBeenCalledWith({ rota: '/auth/login', dimensao: 'conta' });
  });

  it('contador que lança tem o mesmo efeito de contador indisponível', async () => {
    // Nada pode escapar daqui: um erro subindo viraria 500 numa rota que só deveria seguir.
    const { politica, medidor } = montar({
      ler: () => Promise.reject(new Error('mongo fora')),
    });

    await expect(politica.verificar(CONSULTA)).resolves.toMatchObject({ permitido: true });
    expect(medidor.contarErroDoContador).toHaveBeenCalledOnce();
  });

  it('mede a duração da consulta ao contador', async () => {
    const { politica, medidor } = montar({ ler: () => Promise.resolve(estado(1)) });

    await politica.verificar(CONSULTA);

    expect(medidor.observarDuracao).toHaveBeenCalledOnce();
  });
});

describe('debitar', () => {
  it('incrementa a chave da consulta', async () => {
    const chaves: string[] = [];
    const { politica } = montar({
      incrementar: (chave) => {
        chaves.push(chave);
        return Promise.resolve(estado(1));
      },
    });

    await politica.debitar(CONSULTA);

    expect(chaves).toHaveLength(1);
    // A chave que chega ao contador é o digest, nunca o e-mail.
    expect(chaves[0]).not.toContain('admin@iam.local');
    expect(chaves[0]).toMatch(/^conta:[0-9a-f]{64}$/);
  });

  it('falha do contador é contada e não lança', async () => {
    const { politica, medidor } = montar({ incrementar: () => Promise.resolve(null) });

    await expect(politica.debitar(CONSULTA)).resolves.toBeUndefined();
    expect(medidor.contarErroDoContador).toHaveBeenCalledOnce();
  });

  it('contador que lança no débito também não derruba a requisição', async () => {
    const { politica, medidor } = montar({
      incrementar: () => Promise.reject(new Error('mongo fora')),
    });

    await expect(politica.debitar(CONSULTA)).resolves.toBeUndefined();
    expect(medidor.contarErroDoContador).toHaveBeenCalledOnce();
  });
});
