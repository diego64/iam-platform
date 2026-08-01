/**
 * Cobre o AuthService: login feliz emite o par de tokens; usuário inexistente paga o hash
 * fantasma e falha genérico; senha errada e conta bloqueada falham genérico com o motivo só
 * na métrica; logout revoga o jti e o refresh; perfil monta o DTO com papéis.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  criarAuthService,
  type DependenciasDoAuthService,
} from '../../../../src/modules/auth/services/auth.service.js';
import { ErroDeAutenticacao } from '../../../../src/modules/auth/errors/auth-error.js';
import type { ServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import type { RepositorioDeAutenticacao } from '../../../../src/modules/auth/repositories/auth-user.repository.js';
import type { StatusDeUsuario } from '../../../../src/modules/users/entities/user.entity.js';

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
const FANTASMA = 'scrypt$16384$8$1$Zg==$Zg==';

function servicoDeSenhaFake(): { servico: ServicoDeSenha; fantasmaUsado: () => boolean } {
  let usouFantasma = false;
  return {
    fantasmaUsado: () => usouFantasma,
    servico: {
      gerarHash: () => Promise.resolve(HASH),
      // Confere quando a senha é 'correta' e o hash é o real (não o fantasma).
      verificar: (senha: string, hash: string) =>
        Promise.resolve(senha === 'correta' && hash === HASH),
      precisaRehash: () => false,
      hashFantasma: () => {
        usouFantasma = true;
        return Promise.resolve(FANTASMA);
      },
    },
  };
}

function repoFake(
  usuario: {
    id: string;
    email: string;
    status: StatusDeUsuario;
    roles: string[];
  } | null,
): RepositorioDeAutenticacao {
  return {
    buscarPorEmail: () =>
      Promise.resolve(
        usuario === null
          ? null
          : { id: usuario.id, email: usuario.email, status: usuario.status, passwordHash: HASH },
      ),
    buscarPorId: () =>
      Promise.resolve(
        usuario === null ? null : { id: usuario.id, email: usuario.email, status: usuario.status },
      ),
    papeisDoUsuario: () => Promise.resolve(usuario?.roles ?? []),
  };
}

function montar(
  usuario: Parameters<typeof repoFake>[0],
  sobrescritas: Partial<DependenciasDoAuthService> = {},
): {
  service: ReturnType<typeof criarAuthService>;
  fantasmaUsado: () => boolean;
  emitir: ReturnType<typeof vi.fn>;
  revogar: ReturnType<typeof vi.fn>;
  revogarRefresh: ReturnType<typeof vi.fn>;
  contarFalha: ReturnType<typeof vi.fn>;
  contarSucesso: ReturnType<typeof vi.fn>;
} {
  const { servico, fantasmaUsado } = servicoDeSenhaFake();
  const emitir = vi.fn(() =>
    Promise.resolve({ token: 'jwt-abc', jti: 'j1', expiraEm: new Date(), ttlSegundos: 900 }),
  );
  const revogar = vi.fn(() => Promise.resolve());
  const revogarRefresh = vi.fn(() => Promise.resolve());
  const contarFalha = vi.fn();
  const contarSucesso = vi.fn();

  const service = criarAuthService({
    repo: repoFake(usuario),
    servicoDeSenha: servico,
    tokenService: { emitir },
    refreshToken: { emitir: () => Promise.resolve('refresh-opaco'), revogar: revogarRefresh },
    denylist: { revogar, estaRevogado: () => Promise.resolve(false) },
    medidor: { contarFalha, contarSucesso, observarValidacao: () => undefined },
    ...sobrescritas,
  });

  return { service, fantasmaUsado, emitir, revogar, revogarRefresh, contarFalha, contarSucesso };
}

describe('login', () => {
  it('emite o par de tokens no caminho feliz', async () => {
    const { service, contarSucesso } = montar({
      id: 'u1',
      email: 'a@iam.local',
      status: 'active',
      roles: ['admin'],
    });

    const par = await service.login({ email: 'a@iam.local', senha: 'correta' });
    expect(par).toEqual({
      accessToken: 'jwt-abc',
      refreshToken: 'refresh-opaco',
      expiraEmSegundos: 900,
    });
    expect(contarSucesso).toHaveBeenCalledOnce();
  });

  it('usuário inexistente paga o hash fantasma e falha genérico', async () => {
    const { service, fantasmaUsado, contarFalha } = montar(null);

    await expect(service.login({ email: 'x@iam.local', senha: 'qualquer' })).rejects.toBeInstanceOf(
      ErroDeAutenticacao,
    );
    expect(fantasmaUsado()).toBe(true);
    expect(contarFalha).toHaveBeenCalledWith('desconhecido');
  });

  it('senha errada falha genérico', async () => {
    const { service, contarFalha } = montar({
      id: 'u1',
      email: 'a@iam.local',
      status: 'active',
      roles: [],
    });

    await expect(service.login({ email: 'a@iam.local', senha: 'errada' })).rejects.toBeInstanceOf(
      ErroDeAutenticacao,
    );
    expect(contarFalha).toHaveBeenCalledWith('senha');
  });

  it('conta bloqueada falha genérico mesmo com senha certa', async () => {
    const { service, contarFalha, emitir } = montar({
      id: 'u1',
      email: 'a@iam.local',
      status: 'blocked',
      roles: [],
    });

    await expect(service.login({ email: 'a@iam.local', senha: 'correta' })).rejects.toBeInstanceOf(
      ErroDeAutenticacao,
    );
    expect(contarFalha).toHaveBeenCalledWith('bloqueado');
    expect(emitir).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('revoga o jti na denylist e o refresh token', async () => {
    const { service, revogar, revogarRefresh } = montar(null);
    const expiraEm = new Date(Date.now() + 60_000);

    await service.logout({ jti: 'j1', userId: 'u1', expiraEm, refreshToken: 'r1' });

    expect(revogar).toHaveBeenCalledWith({
      jti: 'j1',
      userId: 'u1',
      motivo: 'logout',
      expiraEm,
    });
    expect(revogarRefresh).toHaveBeenCalledWith('r1');
  });
});

describe('perfil', () => {
  it('monta o DTO com papéis, sem hash', async () => {
    const { service } = montar({
      id: 'u1',
      email: 'a@iam.local',
      status: 'active',
      roles: ['admin'],
    });

    expect(await service.perfil('u1')).toEqual({
      id: 'u1',
      email: 'a@iam.local',
      status: 'active',
      roles: ['admin'],
    });
  });
});
