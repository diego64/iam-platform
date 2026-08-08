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
    permissoesEfetivas: () => Promise.resolve([]),
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

  it('sem recorte, o token leva a autoridade inteira e o escopo padrão', async () => {
    const { service, emitir } = montar(
      { id: 'u1', email: 'a@iam.local', status: 'active', roles: ['admin'] },
      {
        repo: {
          ...repoFake({ id: 'u1', email: 'a@iam.local', status: 'active', roles: ['admin'] }),
          permissoesEfetivas: () => Promise.resolve(['*']),
        },
        scopePadrao: 'leitura',
      },
    );

    await service.login({ email: 'a@iam.local', senha: 'correta' });

    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['*'], scope: 'leitura' }),
      undefined,
    );
  });

  it('o recorte de autoridade rebaixa as permissões e o escopo do token', async () => {
    // O cenário que a emissão por OAuth precisa: superadmin autenticando por um cliente que
    // só tem `orders:read` sai com um token de `orders:read`, não com o curinga.
    const { service, emitir } = montar(
      { id: 'u1', email: 'a@iam.local', status: 'active', roles: ['superadmin'] },
      {
        repo: {
          ...repoFake({ id: 'u1', email: 'a@iam.local', status: 'active', roles: ['superadmin'] }),
          permissoesEfetivas: () => Promise.resolve(['*']),
        },
      },
    );

    const par = await service.login(
      { email: 'a@iam.local', senha: 'correta' },
      {
        restringirAutoridade: (permissoes) => {
          expect(permissoes).toEqual(['*']);
          return { permissoes: ['orders:read'], escopo: 'orders:read' };
        },
        ttlSegundos: 120,
      },
    );

    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'u1',
        roles: ['superadmin'],
        permissions: ['orders:read'],
        scope: 'orders:read',
      }),
      { ttlSegundos: 120 },
    );
    expect(par).toMatchObject({ accessToken: 'jwt-abc' });
  });
});

describe('login com segundo fator', () => {
  function comMfa(opcoes: {
    desafio?: { token: string; expiraEmSegundos: number } | null;
    resolvido?: { userId: string; metodo: 'otp' | 'recovery' } | null;
  }): ReturnType<typeof montar> & { desafiar: ReturnType<typeof vi.fn> } {
    const desafiar = vi.fn(() => Promise.resolve(opcoes.desafio ?? null));
    const resolver = vi.fn(() => Promise.resolve(opcoes.resolvido ?? null));
    const fakes = montar(
      { id: 'u1', email: 'a@iam.local', status: 'active', roles: ['admin'] },
      { mfa: { desafiar, resolver } },
    );
    return { ...fakes, desafiar };
  }

  it('sem porta de MFA o login segue de um passo só', async () => {
    // É esta linha que mantém a suíte da SPEC 001 válida: porta ausente, nada muda.
    const { service } = montar({
      id: 'u1',
      email: 'a@iam.local',
      status: 'active',
      roles: [],
    });

    const resultado = await service.login({ email: 'a@iam.local', senha: 'correta' });

    expect(resultado).toMatchObject({ accessToken: 'jwt-abc' });
  });

  it('com fator ativo devolve o desafio e nenhum token', async () => {
    const { service, emitir } = comMfa({
      desafio: { token: 'mfa-token', expiraEmSegundos: 300 },
    });

    const resultado = await service.login({ email: 'a@iam.local', senha: 'correta' });

    expect(resultado).toEqual({
      mfaRequerido: true,
      mfaToken: 'mfa-token',
      expiraEmSegundos: 300,
    });
    expect(emitir).not.toHaveBeenCalled();
  });

  it('o desafio só é pedido depois de a senha conferir', async () => {
    const { service, desafiar } = comMfa({ desafio: null });

    await expect(service.login({ email: 'a@iam.local', senha: 'errada' })).rejects.toBeInstanceOf(
      ErroDeAutenticacao,
    );
    expect(desafiar).not.toHaveBeenCalled();
  });
});

describe('concluirDesafio', () => {
  function comResolucao(
    resolvido: { userId: string; metodo: 'otp' | 'recovery' } | null,
  ): ReturnType<typeof montar> {
    return montar(
      { id: 'u1', email: 'a@iam.local', status: 'active', roles: ['admin'] },
      {
        mfa: {
          desafiar: () => Promise.resolve(null),
          resolver: () => Promise.resolve(resolvido),
        },
      },
    );
  }

  it('emite o par com amr e mfa quando o código confere', async () => {
    const { service, emitir } = comResolucao({ userId: 'u1', metodo: 'otp' });

    const par = await service.concluirDesafio('mfa-token', { codigo: '123456' });

    expect(par).toMatchObject({ accessToken: 'jwt-abc', refreshToken: 'refresh-opaco' });
    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({ amr: ['pwd', 'otp'], mfa: true }),
      undefined,
    );
  });

  it('marca o método quando veio de código de recuperação', async () => {
    const { service, emitir } = comResolucao({ userId: 'u1', metodo: 'recovery' });

    await service.concluirDesafio('mfa-token', { codigoDeRecuperacao: 'ABCDEF' });

    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({ amr: ['pwd', 'recovery'] }),
      undefined,
    );
  });

  it('desafio não resolvido falha sem emitir token', async () => {
    const { service, emitir, contarFalha } = comResolucao(null);

    await expect(service.concluirDesafio('mfa-token', { codigo: '000000' })).rejects.toMatchObject({
      codigo: 'desafio-mfa-invalido',
    });
    expect(emitir).not.toHaveBeenCalled();
    expect(contarFalha).toHaveBeenCalledWith('mfa');
  });

  it('conta bloqueada entre a senha e o segundo fator não recebe token', async () => {
    // O desafio vale cinco minutos; nesse intervalo dá tempo de a conta cair.
    const bloqueado = montar(
      { id: 'u1', email: 'a@iam.local', status: 'blocked', roles: [] },
      {
        mfa: {
          desafiar: () => Promise.resolve(null),
          resolver: () => Promise.resolve({ userId: 'u1', metodo: 'otp' as const }),
        },
      },
    );

    await expect(
      bloqueado.service.concluirDesafio('mfa-token', { codigo: '123456' }),
    ).rejects.toMatchObject({ codigo: 'credencial-invalida' });
    expect(bloqueado.emitir).not.toHaveBeenCalled();
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
