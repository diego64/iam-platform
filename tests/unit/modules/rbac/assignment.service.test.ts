/**
 * Cobre o AssignmentService com repositório fake: leitura de papéis com recusa de usuário
 * inexistente (404) e delegação da atribuição (a validação atômica é do repositório).
 */
import { describe, expect, it, vi } from 'vitest';
import { criarAssignmentService } from '../../../../src/modules/rbac/services/assignment.service.js';
import { ErroDeRbac } from '../../../../src/modules/rbac/errors/rbac.errors.js';
import type { RepositorioDeAssociacao } from '../../../../src/modules/rbac/repositories/assignment.repository.js';

function fakeRepo(over: Partial<RepositorioDeAssociacao> = {}): RepositorioDeAssociacao {
  return {
    associarPermissoes: () => Promise.resolve(),
    desassociarPermissao: () => Promise.resolve(),
    permissoesDoPapel: () => Promise.resolve([]),
    permissoesEfetivas: () => Promise.resolve([]),
    papeisDoUsuario: () => Promise.resolve([]),
    atribuirPapeis: () => Promise.resolve(),
    desatribuirPapel: () => Promise.resolve(),
    usuarioExiste: () => Promise.resolve(true),
    ...over,
  };
}

describe('AssignmentService', () => {
  it('listarPapeisDoUsuario de usuário inexistente dispara usuario-nao-encontrado', async () => {
    const svc = criarAssignmentService({
      associacoes: fakeRepo({ usuarioExiste: () => Promise.resolve(false) }),
    });
    await expect(svc.listarPapeisDoUsuario('nao-existe')).rejects.toBeInstanceOf(ErroDeRbac);
  });

  it('listarPapeisDoUsuario devolve os papéis quando o usuário existe', async () => {
    const svc = criarAssignmentService({
      associacoes: fakeRepo({
        papeisDoUsuario: () => Promise.resolve([{ id: 'r1', name: 'admin' }]),
      }),
    });
    const resultado = await svc.listarPapeisDoUsuario('u1');
    expect(resultado).toEqual({ userId: 'u1', roles: [{ id: 'r1', name: 'admin' }] });
  });

  it('atribuirPapeis delega ao repositório e propaga a recusa de existência', async () => {
    const atribuir = vi.fn(() => Promise.reject(new ErroDeRbac('papel-nao-encontrado')));
    const svc = criarAssignmentService({ associacoes: fakeRepo({ atribuirPapeis: atribuir }) });
    await expect(svc.atribuirPapeis('u1', ['r-x'])).rejects.toBeInstanceOf(ErroDeRbac);
    expect(atribuir).toHaveBeenCalledWith('u1', ['r-x']);
  });
});
