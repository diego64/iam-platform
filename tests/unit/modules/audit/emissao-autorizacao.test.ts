/**
 * Cobre a emissão de eventos pelos serviços de autorização, token e credencial: concessão de
 * papel e de permissão, rotação de refresh, reuso detectado, cliente de API e rotação de
 * chave.
 *
 * São as operações que mudam quem pode o quê. A verificação central de cada caso é dupla:
 * o evento sai com o alvo certo, e o segredo envolvido (token, segredo de cliente, chave
 * privada) não sai junto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { criarAssignmentService } from '../../../../src/modules/rbac/services/assignment.service.js';
import { criarRbacService } from '../../../../src/modules/rbac/services/rbac.service.js';
import type { RepositorioDeAssociacao } from '../../../../src/modules/rbac/repositories/assignment.repository.js';
import type { RepositorioDePapel } from '../../../../src/modules/rbac/repositories/role.repository.js';
import type { RepositorioDePermissao } from '../../../../src/modules/rbac/repositories/permission.repository.js';
import { criarRefreshTokenService } from '../../../../src/modules/refresh-token/services/refresh-token.service.js';
import { criarRegistradorFake, type RegistradorFake } from '../../../mocks/auditoria.js';

let auditoria: RegistradorFake;

beforeEach(() => {
  auditoria = criarRegistradorFake();
});

function associacoesFake(): RepositorioDeAssociacao {
  return {
    usuarioExiste: () => Promise.resolve(true),
    papeisDoUsuario: () => Promise.resolve([]),
    atribuirPapeis: () => Promise.resolve(),
    desatribuirPapel: () => Promise.resolve(),
    associarPermissoes: () => Promise.resolve(),
    desassociarPermissao: () => Promise.resolve(),
    permissoesDoPapel: () => Promise.resolve([]),
  } as unknown as RepositorioDeAssociacao;
}

describe('concessão de papel', () => {
  it('registra a atribuição com o usuário como alvo e os papéis concedidos', async () => {
    const service = criarAssignmentService({ associacoes: associacoesFake(), auditoria });

    await service.atribuirPapeis('u1', ['r1', 'r2']);

    const evento = auditoria.doTipo('iam.role.assigned');
    expect(evento?.target).toEqual({ id: 'u1', type: 'user' });
    expect(evento?.metadata).toEqual({ role_ids: ['r1', 'r2'] });
  });

  it('registra a revogação do papel', async () => {
    const service = criarAssignmentService({ associacoes: associacoesFake(), auditoria });

    await service.desatribuirPapel('u1', 'r1');

    expect(auditoria.tipos()).toEqual(['iam.role.revoked']);
    expect(auditoria.doTipo('iam.role.revoked')?.metadata).toEqual({ role_ids: ['r1'] });
  });

  it('não registra quando o usuário nem existe para listar papéis', async () => {
    const associacoes = associacoesFake();
    const service = criarAssignmentService({
      associacoes: { ...associacoes, usuarioExiste: () => Promise.resolve(false) },
      auditoria,
    });

    await expect(service.listarPapeisDoUsuario('u1')).rejects.toThrow();

    expect(auditoria.eventos).toEqual([]);
  });
});

describe('concessão de permissão a papel', () => {
  it('registra o papel como alvo — o efeito alcança todos que o possuem', async () => {
    const service = criarRbacService({
      papeis: {} as RepositorioDePapel,
      permissoes: {} as RepositorioDePermissao,
      associacoes: associacoesFake(),
      auditoria,
    });

    await service.associarPermissoes('papel-1', ['p1', 'p2']);

    const evento = auditoria.doTipo('iam.role.permission_granted');
    expect(evento?.target).toEqual({ id: 'papel-1', type: 'role' });
    expect(evento?.metadata).toEqual({ permission_ids: ['p1', 'p2'] });
  });
});

describe('rotação de refresh token', () => {
  const AGORA = Date.now();

  function docAtivo(): {
    tokenHash: string;
    familyId: string;
    userId: string;
    status: 'active' | 'rotated';
    rotatedAt: Date | null;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    clientId: string | null;
    escopo: string | null;
    amr: readonly string[];
  } {
    return {
      tokenHash: 'hash',
      familyId: 'fam-1',
      userId: 'u1',
      status: 'active' as const,
      rotatedAt: null,
      idleExpiresAt: new Date(AGORA + 60_000),
      absoluteExpiresAt: new Date(AGORA + 600_000),
      clientId: null,
      escopo: null,
      amr: ['pwd'],
    };
  }

  function montar(doc: ReturnType<typeof docAtivo>): ReturnType<typeof criarRefreshTokenService> {
    return criarRefreshTokenService({
      repo: {
        registrar: () => Promise.resolve(),
        buscarPorHash: () => Promise.resolve(doc),
        rotacionarAtomico: () => Promise.resolve(doc),
        revogarFamilia: () => Promise.resolve(),
        revogarDoUsuario: () => Promise.resolve(),
      },
      usuarios: {
        buscarPorId: () =>
          Promise.resolve({ id: 'u1', email: 'a@iam.local', status: 'active' as const }),
        papeisDoUsuario: () => Promise.resolve([]),
        permissoesEfetivas: () => Promise.resolve([]),
      },
      tokenService: {
        emitir: () =>
          Promise.resolve({ token: 'jwt', jti: 'j1', expiraEm: new Date(), ttlSegundos: 900 }),
      },
      ttlIdleMs: 60_000,
      ttlAbsolutoMs: 600_000,
      graceMs: 1_000,
      auditoria,
    });
  }

  it('registra a rotação com a família como alvo, sem o token', async () => {
    await montar(docAtivo()).rotacionar('token-opaco');

    const evento = auditoria.doTipo('iam.token.refreshed');
    expect(evento?.target).toEqual({ id: 'fam-1', type: 'session' });
    expect(JSON.stringify(evento)).not.toContain('token-opaco');
  });

  it('registra o reuso detectado como falha, e não como rotação', async () => {
    const consumido = { ...docAtivo(), status: 'rotated' as const, rotatedAt: new Date(0) };

    await expect(montar(consumido).rotacionar('token-opaco')).rejects.toThrow();

    expect(auditoria.tipos()).toEqual(['iam.token.reuse_detected']);
    expect(auditoria.doTipo('iam.token.reuse_detected')?.outcome).toBe('failure');
    expect(auditoria.doTipo('iam.token.reuse_detected')?.reason).toBe('token_reused');
  });
});
