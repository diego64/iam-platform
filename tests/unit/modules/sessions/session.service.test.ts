/**
 * Cobre o SessionService: a listagem marca a atual e conta as ativas; revogar por id checa a
 * posse (404 quando não é do usuário) e delega o encerramento da família; "encerrar as demais"
 * preserva a atual; o gancho de revogação marca a sessão e conta a métrica.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  criarSessionService,
  type RevogadorDeFamilia,
} from '../../../../src/modules/sessions/services/session.service.js';
import { ErroDeSessaoNaoEncontrada } from '../../../../src/modules/sessions/errors/session-error.js';
import type {
  RepositorioDeSessoes,
  SessaoAtiva,
} from '../../../../src/modules/sessions/repositories/session.repository.js';

function sessao(sessionId: string): SessaoAtiva {
  return {
    sessionId,
    ip: '203.0.113.1',
    userAgent: 'ua',
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

interface Fakes {
  service: ReturnType<typeof criarSessionService>;
  pertenceAoUsuario: Mock<(sessionId: string, userId: string) => Promise<boolean>>;
  marcarRevogada: Mock<(sessionId: string) => Promise<void>>;
  revogarFamilia: Mock<RevogadorDeFamilia>;
  medidor: { observarAtivas: Mock; contarRevogacao: Mock };
}

function montar(): Fakes {
  const pertenceAoUsuario = vi.fn<(sessionId: string, userId: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const marcarRevogada = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
  const repo: RepositorioDeSessoes = {
    iniciar: vi.fn(() => Promise.resolve()),
    tocar: vi.fn(() => Promise.resolve()),
    listarAtivas: vi.fn(() => Promise.resolve([sessao('s1'), sessao('s2')])),
    idsAtivasDoUsuario: vi.fn(() => Promise.resolve(['s1', 's2', 's3'])),
    pertenceAoUsuario,
    marcarRevogada,
  };
  const revogarFamilia = vi.fn<RevogadorDeFamilia>(() => Promise.resolve());
  const medidor = { observarAtivas: vi.fn(), contarRevogacao: vi.fn() };
  const service = criarSessionService({ repo, revogarFamilia, medidor });
  return { service, pertenceAoUsuario, marcarRevogada, revogarFamilia, medidor };
}

describe('listar', () => {
  it('marca a sessão atual e conta as ativas', async () => {
    const { service, medidor } = montar();
    const lista = await service.listar('u1', 's2');

    expect(lista.map((s) => [s.id, s.current])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
    expect(medidor.observarAtivas).toHaveBeenCalledWith(2);
  });
});

describe('revogar', () => {
  it('encerra a família quando a sessão é do usuário', async () => {
    const { service, revogarFamilia } = montar();
    await service.revogar('s1', 'u1');
    expect(revogarFamilia).toHaveBeenCalledWith('s1', 'sessao_unica');
  });

  it('lança 404 e não encerra nada quando a sessão não é do usuário', async () => {
    const { service, pertenceAoUsuario, revogarFamilia } = montar();
    pertenceAoUsuario.mockResolvedValueOnce(false);

    await expect(service.revogar('alheia', 'u1')).rejects.toBeInstanceOf(ErroDeSessaoNaoEncontrada);
    expect(revogarFamilia).not.toHaveBeenCalled();
  });
});

describe('revogarOutras', () => {
  it('encerra todas menos a atual e devolve a contagem', async () => {
    const { service, revogarFamilia } = montar();
    const n = await service.revogarOutras('u1', 's2');

    expect(n).toBe(2);
    expect(revogarFamilia).toHaveBeenCalledWith('s1', 'sessao_demais');
    expect(revogarFamilia).toHaveBeenCalledWith('s3', 'sessao_demais');
    expect(revogarFamilia).not.toHaveBeenCalledWith('s2', 'sessao_demais');
  });
});

describe('aoRevogarFamilia', () => {
  it('marca a sessão revogada e conta a métrica com o motivo', async () => {
    const { service, marcarRevogada, medidor } = montar();
    await service.aoRevogarFamilia('s9', 'reuso');
    expect(marcarRevogada).toHaveBeenCalledWith('s9');
    expect(medidor.contarRevogacao).toHaveBeenCalledWith('reuso');
  });
});
