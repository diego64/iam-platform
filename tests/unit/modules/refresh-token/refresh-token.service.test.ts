/**
 * Cobre o RefreshTokenService: rotação feliz emite novo par; token ausente/expirado falha
 * genérico; reuso pós-graça derruba a família; corrida na graça (e corrida atômica) falha
 * sem derrubar; teto absoluto e conta bloqueada barram; erro de I/O recusa (fail closed).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  criarRefreshTokenService,
  type RefreshTokenService,
  type DadosDeAberturaDeSessao,
  type MotivoDeRevogacaoDeFamilia,
} from '../../../../src/modules/refresh-token/services/refresh-token.service.js';
import { ErroDeRefreshInvalido } from '../../../../src/modules/refresh-token/errors/refresh-token-error.js';
import type {
  EntradaDeRegistro,
  RefreshPersistido,
} from '../../../../src/modules/refresh-token/repositories/refresh-token.repository.js';
import type {
  DadosParaToken,
  TokenEmitido,
} from '../../../../src/modules/auth/services/token.service.js';
import type { StatusDeUsuario } from '../../../../src/modules/users/entities/user.entity.js';

type UsuarioLido = { id: string; email: string; status: StatusDeUsuario } | null;

interface Fakes {
  service: RefreshTokenService;
  registrar: Mock<(entrada: EntradaDeRegistro) => Promise<void>>;
  buscarPorHash: Mock<(hash: string) => Promise<RefreshPersistido | null>>;
  rotacionarAtomico: Mock<(hash: string, agora: Date) => Promise<RefreshPersistido | null>>;
  revogarFamilia: Mock<(familyId: string) => Promise<void>>;
  buscarPorId: Mock<(id: string) => Promise<UsuarioLido>>;
  emitir: Mock<(dados: DadosParaToken) => Promise<TokenEmitido>>;
  aoAbrirSessao: Mock<(dados: DadosDeAberturaDeSessao) => Promise<void>>;
  aoTocarSessao: Mock<(sessionId: string) => Promise<void>>;
  aoRevogarFamilia: Mock<(sessionId: string, motivo: MotivoDeRevogacaoDeFamilia) => Promise<void>>;
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
  const buscarPorId = vi.fn<(id: string) => Promise<UsuarioLido>>(() =>
    Promise.resolve({ id: 'u1', email: 'a@iam.local', status: 'active' }),
  );
  const papeisDoUsuario = vi.fn(() => Promise.resolve(['admin']));
  const emitir = vi.fn<(dados: DadosParaToken) => Promise<TokenEmitido>>(() =>
    Promise.resolve({ token: 'jwt-novo', jti: 'j2', expiraEm: new Date(), ttlSegundos: 900 }),
  );
  const aoAbrirSessao = vi.fn<(dados: DadosDeAberturaDeSessao) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const aoTocarSessao = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
  const aoRevogarFamilia = vi.fn<
    (sessionId: string, motivo: MotivoDeRevogacaoDeFamilia) => Promise<void>
  >(() => Promise.resolve());
  const medidor = {
    contarRotacao: vi.fn(),
    contarReuso: vi.fn(),
    contarFalha: vi.fn(),
    observarDuracao: vi.fn(),
  };

  const service = criarRefreshTokenService({
    repo: { registrar, buscarPorHash, rotacionarAtomico, revogarFamilia },
    usuarios: { buscarPorId, papeisDoUsuario },
    tokenService: { emitir },
    ttlIdleMs: 60_000,
    ttlAbsolutoMs: 3_600_000,
    graceMs: 10_000,
    medidor,
    aoAbrirSessao,
    aoTocarSessao,
    aoRevogarFamilia,
  });

  return {
    service,
    registrar,
    buscarPorHash,
    rotacionarAtomico,
    revogarFamilia,
    buscarPorId,
    emitir,
    aoAbrirSessao,
    aoTocarSessao,
    aoRevogarFamilia,
    medidor,
  };
}

const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };

describe('emitir', () => {
  it('persiste um token novo, abre a sessão e devolve token de 88 chars + sessionId', async () => {
    const { service, registrar, aoAbrirSessao } = montar();
    const { token, sessionId } = await service.emitir('u1', CTX);

    expect(token).toHaveLength(88);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registrar).toHaveBeenCalledOnce();
    expect(registrar.mock.calls[0]?.[0]).toMatchObject({ userId: 'u1', familyId: sessionId });
    expect(aoAbrirSessao.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      userId: 'u1',
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });
  });
});

describe('rotacionar', () => {
  it('rotaciona, toca a sessão e reemite o access com o sid da família', async () => {
    const { service, rotacionarAtomico, registrar, emitir, aoTocarSessao, medidor } = montar();
    const par = await service.rotacionar('token-atual');

    expect(par.accessToken).toBe('jwt-novo');
    expect(par.expiraEmSegundos).toBe(900);
    expect(par.refreshToken).toHaveLength(88);
    expect(rotacionarAtomico).toHaveBeenCalledOnce();
    expect(registrar).toHaveBeenCalledOnce(); // o sucessor
    expect(emitir.mock.calls[0]?.[0]).toMatchObject({ sub: 'u1', sid: 'fam-1' });
    expect(aoTocarSessao).toHaveBeenCalledWith('fam-1');
    expect(medidor.contarRotacao).toHaveBeenCalledOnce();
  });

  it('token ausente falha genérico', async () => {
    const { service, buscarPorHash, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(null);

    await expect(service.rotacionar('x')).rejects.toBeInstanceOf(ErroDeRefreshInvalido);
    expect(medidor.contarFalha).toHaveBeenCalledWith('nao_encontrado');
  });

  it('reuso pós-graça derruba a família', async () => {
    const { service, buscarPorHash, revogarFamilia, aoRevogarFamilia, medidor } = montar();
    buscarPorHash.mockResolvedValueOnce(
      docAtivo({ status: 'rotated', rotatedAt: new Date(Date.now() - 20_000) }),
    );

    await expect(service.rotacionar('antigo')).rejects.toMatchObject({ motivo: 'reuso' });
    expect(revogarFamilia).toHaveBeenCalledWith('fam-1');
    expect(aoRevogarFamilia).toHaveBeenCalledWith('fam-1', 'reuso');
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
  it('derruba a família do token apresentado e reflete na sessão (logout)', async () => {
    const { service, revogarFamilia, aoRevogarFamilia } = montar();
    await service.revogar('tok');
    expect(revogarFamilia).toHaveBeenCalledWith('fam-1');
    expect(aoRevogarFamilia).toHaveBeenCalledWith('fam-1', 'logout');
  });

  it('token desconhecido é no-op', async () => {
    const { service, buscarPorHash, revogarFamilia } = montar();
    buscarPorHash.mockResolvedValueOnce(null);
    await service.revogar('desconhecido');
    expect(revogarFamilia).not.toHaveBeenCalled();
  });
});

describe('revogarFamilia', () => {
  it('encerra a família e reflete o motivo na sessão', async () => {
    const { service, revogarFamilia, aoRevogarFamilia } = montar();
    await service.revogarFamilia('fam-9', 'sessao_unica');
    expect(revogarFamilia).toHaveBeenCalledWith('fam-9');
    expect(aoRevogarFamilia).toHaveBeenCalledWith('fam-9', 'sessao_unica');
  });

  it('não deixa o reflexo na sessão derrubar a revogação dos tokens', async () => {
    const { service, revogarFamilia, aoRevogarFamilia } = montar();
    aoRevogarFamilia.mockRejectedValueOnce(new Error('sessão indisponível'));
    await expect(service.revogarFamilia('fam-9', 'logout')).resolves.toBeUndefined();
    expect(revogarFamilia).toHaveBeenCalledWith('fam-9');
  });
});
