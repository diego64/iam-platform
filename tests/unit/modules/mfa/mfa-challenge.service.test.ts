/**
 * Cobre o serviço de desafio: emissão só para quem tem fator ativo, resposta única para toda
 * falha, uso único do desafio, teto de tentativas, anti-replay e código de recuperação.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarServicoDeDesafioDeMfa } from '../../../../src/modules/mfa/services/mfa-challenge.service.js';
import { gerarCodigo, passoDe } from '../../../../src/modules/mfa/services/totp.js';
import { cifrarSegredo } from '../../../../src/shared/crypto/key-envelope.js';
import type { PortaDeMfa } from '../../../../src/modules/auth/interfaces/mfa.port.js';
import type { FatorDeMfa } from '../../../../src/modules/mfa/repositories/mfa-factor.repository.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const SEGREDO = Buffer.from('12345678901234567890', 'ascii');
const MAX_TENTATIVAS = 5;

function fatorAtivo(sobrescritas: Partial<FatorDeMfa> = {}): FatorDeMfa {
  return {
    id: 'f1',
    userId: 'u1',
    status: 'active',
    segredoCifrado: cifrarSegredo(SEGREDO, MASTER),
    label: null,
    ultimoPasso: null,
    confirmadoEm: new Date(),
    ultimoUsoEm: null,
    ...sobrescritas,
  };
}

interface Fakes {
  service: PortaDeMfa;
  criar: ReturnType<typeof vi.fn>;
  consumirDesafio: ReturnType<typeof vi.fn>;
  registrarFalha: ReturnType<typeof vi.fn>;
  removerDesafio: ReturnType<typeof vi.fn>;
  consumirCodigo: ReturnType<typeof vi.fn>;
  registrarUso: ReturnType<typeof vi.fn>;
  medidor: {
    contarDesafio: ReturnType<typeof vi.fn>;
    contarVerificacao: ReturnType<typeof vi.fn>;
    contarCadastro: ReturnType<typeof vi.fn>;
    contarReplayBloqueado: ReturnType<typeof vi.fn>;
    observarVerificacao: ReturnType<typeof vi.fn>;
  };
}

function montar(
  opcoes: {
    fator?: FatorDeMfa | null;
    desafio?: { userId: string; tentativas: number } | null;
    codigoValido?: boolean;
  } = {},
): Fakes {
  const criar = vi.fn(() => Promise.resolve());
  const consumirDesafio = vi.fn(() =>
    Promise.resolve(
      opcoes.desafio === undefined ? { userId: 'u1', tentativas: 0 } : opcoes.desafio,
    ),
  );
  const registrarFalha = vi.fn(() => Promise.resolve(1));
  const removerDesafio = vi.fn(() => Promise.resolve());
  const consumirCodigo = vi.fn(() => Promise.resolve(opcoes.codigoValido ?? true));
  const registrarUso = vi.fn(() => Promise.resolve());
  const medidor = {
    contarDesafio: vi.fn(),
    contarVerificacao: vi.fn(),
    contarCadastro: vi.fn(),
    contarReplayBloqueado: vi.fn(),
    observarVerificacao: vi.fn(),
  };

  const fator = opcoes.fator === undefined ? fatorAtivo() : opcoes.fator;
  const desafio = opcoes.desafio === undefined ? { userId: 'u1', tentativas: 0 } : opcoes.desafio;

  const service = criarServicoDeDesafioDeMfa({
    fatores: {
      buscarAtivo: () => Promise.resolve(fator),
      buscarPendente: () => Promise.resolve(null),
      criarPendente: () => Promise.resolve(fatorAtivo()),
      ativar: () => Promise.resolve(true),
      registrarUso,
      removerDoUsuario: () => Promise.resolve(1),
    },
    codigos: {
      substituir: () => Promise.resolve(),
      consumir: consumirCodigo,
      contarValidos: () => Promise.resolve(10),
      removerDoUsuario: () => Promise.resolve(),
    },
    desafios: {
      criar,
      buscar: () => Promise.resolve(desafio),
      consumir: consumirDesafio,
      registrarFalha,
      remover: removerDesafio,
      removerDoUsuario: () => Promise.resolve(),
    },
    masterKey: MASTER,
    ttlMs: 300_000,
    maxTentativas: MAX_TENTATIVAS,
    medidor,
  });

  return {
    service,
    criar,
    consumirDesafio,
    registrarFalha,
    removerDesafio,
    consumirCodigo,
    registrarUso,
    medidor,
  };
}

describe('desafiar', () => {
  it('emite um token opaco para quem tem fator ativo', async () => {
    const { service, criar, medidor } = montar();

    const desafio = await service.desafiar('u1');

    expect(desafio?.token).toHaveLength(43);
    expect(desafio?.expiraEmSegundos).toBe(300);
    expect(medidor.contarDesafio).toHaveBeenCalledOnce();

    // O que vai para o banco é o hash, nunca o token.
    const gravado = criar.mock.calls[0]?.[0] as { tokenHash: string };
    expect(gravado.tokenHash).not.toBe(desafio?.token);
    expect(gravado.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('devolve null para quem não tem fator ativo', async () => {
    const { service, criar } = montar({ fator: null });

    await expect(service.desafiar('u1')).resolves.toBeNull();
    expect(criar).not.toHaveBeenCalled();
  });
});

describe('resolver com TOTP', () => {
  const codigoAtual = (): string => gerarCodigo(SEGREDO, passoDe(Date.now()));

  it('aceita o código válido, consome o desafio e grava o passo', async () => {
    const { service, consumirDesafio, registrarUso } = montar();

    await expect(service.resolver('token', { codigo: codigoAtual() })).resolves.toEqual({
      userId: 'u1',
      metodo: 'otp',
    });
    expect(consumirDesafio).toHaveBeenCalledOnce();
    expect(registrarUso).toHaveBeenCalledWith('f1', passoDe(Date.now()));
  });

  it('recusa código errado e conta a tentativa', async () => {
    const { service, registrarFalha, medidor } = montar();

    await expect(service.resolver('token', { codigo: '000000' })).resolves.toBeNull();
    expect(registrarFalha).toHaveBeenCalledOnce();
    expect(medidor.contarVerificacao).toHaveBeenCalledWith('totp', 'failure');
  });

  it('código correto de passo já usado conta como replay', async () => {
    // O caso que o contador dedicado existe para achar: alguém viu o código e o repetiu.
    const passo = passoDe(Date.now());
    const { service, medidor } = montar({ fator: fatorAtivo({ ultimoPasso: passo }) });

    await expect(
      service.resolver('token', { codigo: gerarCodigo(SEGREDO, passo) }),
    ).resolves.toBeNull();
    expect(medidor.contarReplayBloqueado).toHaveBeenCalledOnce();
  });

  it('código simplesmente errado não conta como replay', async () => {
    const { service, medidor } = montar({ fator: fatorAtivo({ ultimoPasso: 1 }) });

    await service.resolver('token', { codigo: '000000' });

    expect(medidor.contarReplayBloqueado).not.toHaveBeenCalled();
  });

  it('desafio inexistente devolve null sem contar tentativa', async () => {
    const { service, registrarFalha } = montar({ desafio: null });

    await expect(service.resolver('token', { codigo: codigoAtual() })).resolves.toBeNull();
    expect(registrarFalha).not.toHaveBeenCalled();
  });

  it('tentativas esgotadas destroem o desafio', async () => {
    const { service, removerDesafio } = montar({
      desafio: { userId: 'u1', tentativas: MAX_TENTATIVAS },
    });

    await expect(service.resolver('token', { codigo: codigoAtual() })).resolves.toBeNull();
    expect(removerDesafio).toHaveBeenCalledOnce();
  });

  it('a falha que atinge o teto destrói o desafio', async () => {
    const { service, registrarFalha, removerDesafio } = montar();
    registrarFalha.mockResolvedValueOnce(MAX_TENTATIVAS);

    await service.resolver('token', { codigo: '000000' });

    expect(removerDesafio).toHaveBeenCalledOnce();
  });

  it('perder a corrida pelo desafio não emite token', async () => {
    // Dois verify simultâneos: o segundo encontra o desafio já consumido.
    const { service, consumirDesafio } = montar();
    consumirDesafio.mockResolvedValueOnce(null);

    await expect(service.resolver('token', { codigo: codigoAtual() })).resolves.toBeNull();
  });

  it('sem código e sem código de recuperação é falha', async () => {
    const { service, registrarFalha } = montar();

    await expect(service.resolver('token', {})).resolves.toBeNull();
    expect(registrarFalha).toHaveBeenCalledOnce();
  });
});

describe('resolver com código de recuperação', () => {
  it('aceita o código e marca o método', async () => {
    const { service, consumirCodigo, medidor } = montar();

    await expect(
      service.resolver('token', { codigoDeRecuperacao: 'ABCDEF-GHJKLM-NPQRST-UVWXYZ' }),
    ).resolves.toEqual({ userId: 'u1', metodo: 'recovery' });
    expect(consumirCodigo).toHaveBeenCalledWith('u1', expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(medidor.contarVerificacao).toHaveBeenCalledWith('recovery', 'success');
  });

  it('código já usado é recusado e conta tentativa', async () => {
    const { service, registrarFalha } = montar({ codigoValido: false });

    await expect(
      service.resolver('token', { codigoDeRecuperacao: 'ABCDEF-GHJKLM-NPQRST-UVWXYZ' }),
    ).resolves.toBeNull();
    expect(registrarFalha).toHaveBeenCalledOnce();
  });

  it('perder a corrida pelo desafio não emite token nem com código válido', async () => {
    const { service, consumirDesafio } = montar();
    consumirDesafio.mockResolvedValueOnce(null);

    await expect(
      service.resolver('token', { codigoDeRecuperacao: 'ABCDEF-GHJKLM-NPQRST-UVWXYZ' }),
    ).resolves.toBeNull();
  });
});
