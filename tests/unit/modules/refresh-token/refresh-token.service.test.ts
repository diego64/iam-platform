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
    // Documento do login por senha: sem dono, sem escopo gravado e de um fator.
    clientId: null,
    escopo: null,
    amr: ['pwd'],
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
  const revogarDoUsuario = vi.fn<(userId: string) => Promise<void>>(() => Promise.resolve());
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
    repo: { registrar, buscarPorHash, rotacionarAtomico, revogarFamilia, revogarDoUsuario },
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

describe('vínculo com o cliente', () => {
  it('grava o dono e o escopo quando a emissão vem de um cliente', async () => {
    const { service, registrar } = montar();

    await service.emitir('u1', { clientId: 'cli_a', escopo: 'orders:read' });

    expect(registrar.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'cli_a',
      escopo: 'orders:read',
    });
  });

  it('emissão sem contexto grava o token sem dono', async () => {
    const { service, registrar } = montar();

    await service.emitir('u1');

    expect(registrar.mock.calls[0]?.[0]).toMatchObject({ clientId: null, escopo: null });
  });

  it('recusa o token de um cliente quando quem resgata é outro', async () => {
    const { service, buscarPorHash, revogarFamilia, rotacionarAtomico } = montar();
    buscarPorHash.mockResolvedValueOnce(docAtivo({ clientId: 'cli_a' }));

    await expect(service.rotacionar('t', { clientIdEsperado: 'cli_b' })).rejects.toMatchObject({
      motivo: 'cliente_divergente',
    });
    // Não derruba a família: revogar daria a qualquer cliente autenticado uma alavanca
    // contra a sessão alheia, bastando apresentar um token que ele não deveria ter.
    expect(revogarFamilia).not.toHaveBeenCalled();
    expect(rotacionarAtomico).not.toHaveBeenCalled();
  });

  it('recusa em /auth/refresh o token que nasceu num cliente', async () => {
    const { service, buscarPorHash } = montar();
    buscarPorHash.mockResolvedValueOnce(docAtivo({ clientId: 'cli_a' }));

    await expect(service.rotacionar('t')).rejects.toMatchObject({ motivo: 'cliente_divergente' });
  });

  it('recusa no cliente o token que nasceu no login por senha', async () => {
    const { service } = montar();

    await expect(service.rotacionar('t', { clientIdEsperado: 'cli_a' })).rejects.toMatchObject({
      motivo: 'cliente_divergente',
    });
  });

  it('a renovação preserva a força da autenticação da família', async () => {
    // Sem isso, a primeira renovação transformaria uma sessão de dois fatores numa que diz
    // ter um só, e qualquer política de fator forte falharia 15 min depois do login.
    const { service, buscarPorHash, rotacionarAtomico, emitir, registrar } = montar();
    const doc = docAtivo({ amr: ['pwd', 'otp'] });
    buscarPorHash.mockResolvedValueOnce(doc);
    rotacionarAtomico.mockResolvedValueOnce(doc);

    await service.rotacionar('t');

    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({ amr: ['pwd', 'otp'], mfa: true }),
      undefined,
    );
    expect(registrar.mock.calls[0]?.[0]).toMatchObject({ amr: ['pwd', 'otp'] });
  });

  it('família de um fator não ganha a claim mfa', async () => {
    const { service, emitir } = montar();

    await service.rotacionar('t');

    expect(emitir).toHaveBeenCalledWith(expect.not.objectContaining({ mfa: true }), undefined);
  });

  it('o sucessor herda o dono e o escopo da família', async () => {
    const { service, buscarPorHash, rotacionarAtomico, registrar } = montar();
    const doc = docAtivo({ clientId: 'cli_a', escopo: 'orders:read' });
    buscarPorHash.mockResolvedValueOnce(doc);
    rotacionarAtomico.mockResolvedValueOnce(doc);

    await service.rotacionar('t', { clientIdEsperado: 'cli_a' });

    expect(registrar.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'cli_a',
      escopo: 'orders:read',
    });
  });

  it('o recorte de autoridade recebe o escopo original e manda no token reemitido', async () => {
    const { service, buscarPorHash, rotacionarAtomico, emitir, registrar } = montar();
    const doc = docAtivo({ clientId: 'cli_a', escopo: 'orders:read orders:write' });
    buscarPorHash.mockResolvedValueOnce(doc);
    rotacionarAtomico.mockResolvedValueOnce(doc);

    await service.rotacionar('t', {
      clientIdEsperado: 'cli_a',
      restringirAutoridade: (entrada) => {
        expect(entrada.escopoOriginal).toBe('orders:read orders:write');
        expect(entrada.permissoesDoUsuario).toEqual(['users:read']);
        return { permissoes: ['orders:read'], escopo: 'orders:read' };
      },
      ttlSegundos: 120,
    });

    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: ['orders:read'],
        scope: 'orders:read',
        clientId: 'cli_a',
      }),
      { ttlSegundos: 120 },
    );
    expect(registrar.mock.calls[0]?.[0]).toMatchObject({ escopo: 'orders:read' });
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
