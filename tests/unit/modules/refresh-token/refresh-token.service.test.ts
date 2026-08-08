/**
 * Cobre o RefreshTokenService: rotação feliz emite novo par; token ausente/expirado falha
 * genérico; reuso pós-graça derruba a família; corrida na graça (e corrida atômica) falha
 * sem derrubar; teto absoluto e conta bloqueada barram; erro de I/O recusa (fail closed).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  criarRefreshTokenService,
  type RefreshTokenService,
} from '../../../../src/modules/refresh-token/services/refresh-token.service.js';
import { ErroDeRefreshInvalido } from '../../../../src/modules/refresh-token/errors/refresh-token-error.js';
import type {
  EntradaDeRegistro,
  RefreshPersistido,
} from '../../../../src/modules/refresh-token/repositories/refresh-token.repository.js';
import type { TokenEmitido } from '../../../../src/modules/auth/services/token.service.js';
import type { StatusDeUsuario } from '../../../../src/modules/users/entities/user.entity.js';

type UsuarioLido = { id: string; email: string; status: StatusDeUsuario } | null;

interface Fakes {
  service: RefreshTokenService;
  registrar: Mock<(entrada: EntradaDeRegistro) => Promise<void>>;
  buscarPorHash: Mock<(hash: string) => Promise<RefreshPersistido | null>>;
  rotacionarAtomico: Mock<(hash: string, agora: Date) => Promise<RefreshPersistido | null>>;
  revogarFamilia: Mock<(familyId: string) => Promise<void>>;
  buscarPorId: Mock<(id: string) => Promise<UsuarioLido>>;
  emitir: Mock<() => Promise<TokenEmitido>>;
  medidor: {
    contarRotacao: Mock;
    contarReuso: Mock;
    contarFalha: Mock;
    observarDuracao: Mock;
  };
}

function docAtivo(sobrescritas: Partial<RefreshPersistido> = {}): RefreshPersistido {
  const agora = Date.now();
  return {
    familyId: 'fam-1',
    userId: 'u1',
    status: 'active',
    rotatedAt: null,
    idleExpiresAt: new Date(agora + 60_000),
    absoluteExpiresAt: new Date(agora + 3_600_000),
    ...sobrescritas,
  };
}

function montar(): Fakes {
  const registrar = vi.fn<(entrada: EntradaDeRegistro) => Promise<void>>(() => Promise.resolve());
  const buscarPorHash = vi.fn<(hash: string) => Promise<RefreshPersistido | null>>(() =>
    Promise.resolve(docAtivo()),
  );
  const rotacionarAtomico = vi.fn<(hash: string, agora: Date) => Promise<RefreshPersistido | null>>(
    () => Promise.resolve(docAtivo()),
  );
  const revogarFamilia = vi.fn<(familyId: string) => Promise<void>>(() => Promise.resolve());
  const revogarDoUsuario = vi.fn<(userId: string) => Promise<number>>(() => Promise.resolve(0));
  const buscarPorId = vi.fn<(id: string) => Promise<UsuarioLido>>(() =>
    Promise.resolve({ id: 'u1', email: 'a@iam.local', status: 'active' }),
  );
  const papeisDoUsuario = vi.fn(() => Promise.resolve(['admin']));
  const permissoesEfetivas = vi.fn(() => Promise.resolve(['users:read']));
  const emitir = vi.fn<() => Promise<TokenEmitido>>(() =>
    Promise.resolve({ token: 'jwt-novo', jti: 'j2', expiraEm: new Date(), ttlSegundos: 900 }),
  );
  const medidor = {
    contarRotacao: vi.fn(),
    contarReuso: vi.fn(),
    contarFalha: vi.fn(),
    observarDuracao: vi.fn(),
  };

  const service = criarRefreshTokenService({
    repo: {
      registrar,
      buscarPorHash,
      rotacionarAtomico,
      revogarFamilia,
      revogarDoUsuario,
      familiasAtivasDoUsuario: () => Promise.resolve([]),
      contarFamiliasAtivas: () => Promise.resolve(0),
      revogarFamiliaDoUsuario: () => Promise.resolve(true),
    },
    usuarios: { buscarPorId, papeisDoUsuario, permissoesEfetivas },
    tokenService: { emitir },
    ttlIdleMs: 60_000,
    ttlAbsolutoMs: 3_600_000,
    graceMs: 10_000,
    medidor,
  });

  return {
    service,
    registrar,
    buscarPorHash,
    rotacionarAtomico,
    revogarFamilia,
    buscarPorId,
    emitir,
    medidor,
  };
}

describe('emitir', () => {
  it('persiste um token novo e o devolve com 88 caracteres', async () => {
    const { service, registrar } = montar();
    const token = await service.emitir('u1');
    expect(token).toHaveLength(88);
    expect(registrar).toHaveBeenCalledOnce();
    expect(registrar.mock.calls[0]?.[0]).toMatchObject({ userId: 'u1' });
  });
});

describe('rotacionar', () => {
  it('rotaciona e emite um novo par no caminho feliz', async () => {
    const { service, rotacionarAtomico, registrar, medidor } = montar();
    const par = await service.rotacionar('token-atual');

    expect(par.accessToken).toBe('jwt-novo');
    expect(par.expiraEmSegundos).toBe(900);
    expect(par.refreshToken).toHaveLength(88);
    expect(rotacionarAtomico).toHaveBeenCalledOnce();
    expect(registrar).toHaveBeenCalledOnce(); // o sucessor
    expect(medidor.contarRotacao).toHaveBeenCalledOnce();
  });

  it('token ausente falha genérico', async () => {
    const { service, buscarPorHash, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(null);

    await expect(service.rotacionar('x')).rejects.toBeInstanceOf(ErroDeRefreshInvalido);
    expect(medidor.contarFalha).toHaveBeenCalledWith('nao_encontrado');
  });

  it('reuso pós-graça derruba a família', async () => {
    const { service, buscarPorHash, revogarFamilia, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(
      docAtivo({ status: 'rotated', rotatedAt: new Date(Date.now() - 20_000) }),
    );

    await expect(service.rotacionar('antigo')).rejects.toMatchObject({ motivo: 'reuso' });
    expect(revogarFamilia).toHaveBeenCalledWith('fam-1');
    expect(medidor.contarReuso).toHaveBeenCalledOnce();
  });

  it('corrida na graça não derruba a família', async () => {
    const { service, buscarPorHash, revogarFamilia } = montar();
    buscarPorHash.mockResolvedValueOnce(
      docAtivo({ status: 'rotated', rotatedAt: new Date(Date.now() - 1_000) }),
    );

    await expect(service.rotacionar('recem-rotacionado')).rejects.toMatchObject({
      motivo: 'corrida',
    });
    expect(revogarFamilia).not.toHaveBeenCalled();
  });

  it('perdedor da rotação atômica falha sem derrubar a família', async () => {
    const { service, rotacionarAtomico, revogarFamilia } = montar();
    rotacionarAtomico.mockResolvedValueOnce(null);

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'corrida' });
    expect(revogarFamilia).not.toHaveBeenCalled();
  });

  it('token além do teto absoluto falha, mesmo com deslizante em aberto', async () => {
    const { service, buscarPorHash, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(docAtivo({ absoluteExpiresAt: new Date(Date.now() - 1) }));

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'absoluto_expirado' });
    expect(medidor.contarFalha).toHaveBeenCalledWith('absoluto_expirado');
  });

  it('token com deslizante expirada falha', async () => {
    const { service, buscarPorHash, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(docAtivo({ idleExpiresAt: new Date(Date.now() - 1) }));

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'idle_expirado' });
    expect(medidor.contarFalha).toHaveBeenCalledWith('idle_expirado');
  });

  it('usuário bloqueado desde o login barra e derruba a família', async () => {
    const { service, buscarPorId, revogarFamilia, medidor } = montar();
    buscarPorId.mockResolvedValueOnce({ id: 'u1', email: 'a@iam.local', status: 'blocked' });

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'usuario_bloqueado' });
    expect(revogarFamilia).toHaveBeenCalledWith('fam-1');
    expect(medidor.contarFalha).toHaveBeenCalledWith('usuario_bloqueado');
  });

  it('erro de I/O no lookup recusa o token (fail closed)', async () => {
    const { service, buscarPorHash } = montar();
    buscarPorHash.mockRejectedValueOnce(new Error('mongo indisponível'));

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'indisponivel' });
  });
});

describe('revogar', () => {
  it('derruba a família do token apresentado', async () => {
    const { service, revogarFamilia } = montar();
    await service.revogar('tok');
    expect(revogarFamilia).toHaveBeenCalledWith('fam-1');
  });

  it('token desconhecido é no-op', async () => {
    const { service, buscarPorHash, revogarFamilia } = montar();
    buscarPorHash.mockResolvedValueOnce(null);
    await service.revogar('desconhecido');
    expect(revogarFamilia).not.toHaveBeenCalled();
  });
});
