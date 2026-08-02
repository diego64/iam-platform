/**
 * Cobre o RbacService com repositórios fake em memória: bloqueio de papel/permissão
 * is_system (409), recusa de inexistente (404) e composição de permissões em obterPapel.
 */
import { describe, expect, it } from 'vitest';
import { criarRbacService } from '../../../../src/modules/rbac/services/rbac.service.js';
import { ErroDeRbac } from '../../../../src/modules/rbac/errors/rbac.errors.js';
import type { Papel, Permissao } from '../../../../src/modules/rbac/entities/rbac.entity.js';
import type { RepositorioDePapel } from '../../../../src/modules/rbac/repositories/role.repository.js';
import type { RepositorioDePermissao } from '../../../../src/modules/rbac/repositories/permission.repository.js';
import type { RepositorioDeAssociacao } from '../../../../src/modules/rbac/repositories/assignment.repository.js';

function fakePapeis(inicial: Papel[] = []): RepositorioDePapel {
  const mapa = new Map(inicial.map((p) => [p.id, p]));
  return {
    criar: ({ name, description }) => {
      const papel: Papel = { id: `r-${name}`, name, description, isSystem: false };
      mapa.set(papel.id, papel);
      return Promise.resolve(papel);
    },
    buscarPorId: (id) => Promise.resolve(mapa.get(id) ?? null),
    listar: () => Promise.resolve([...mapa.values()]),
    contar: () => Promise.resolve(mapa.size),
    atualizar: (id, dados) => {
      const atual = mapa.get(id);
      if (atual === undefined) return Promise.resolve(null);
      const novo: Papel = { ...atual, name: dados.name, description: dados.description };
      mapa.set(id, novo);
      return Promise.resolve(novo);
    },
    remover: (id) => Promise.resolve(mapa.delete(id)),
  };
}

function fakePermissoes(inicial: Permissao[] = []): RepositorioDePermissao {
  const mapa = new Map(inicial.map((p) => [p.id, p]));
  return {
    criar: ({ name, description }) => {
      const permissao: Permissao = { id: `p-${name}`, name, description, isSystem: false };
      mapa.set(permissao.id, permissao);
      return Promise.resolve(permissao);
    },
    buscarPorId: (id) => Promise.resolve(mapa.get(id) ?? null),
    listar: () => Promise.resolve([...mapa.values()]),
    contar: () => Promise.resolve(mapa.size),
    remover: (id) => Promise.resolve(mapa.delete(id)),
  };
}

function fakeAssociacoes(permsDoPapel: string[] = []): RepositorioDeAssociacao {
  return {
    associarPermissoes: () => Promise.resolve(),
    desassociarPermissao: () => Promise.resolve(),
    permissoesDoPapel: () => Promise.resolve(permsDoPapel),
    permissoesEfetivas: () => Promise.resolve([]),
    papeisDoUsuario: () => Promise.resolve([]),
    atribuirPapeis: () => Promise.resolve(),
    desatribuirPapel: () => Promise.resolve(),
    usuarioExiste: () => Promise.resolve(true),
  };
}

const PAPEL_SISTEMA: Papel = {
  id: 'sys',
  name: 'superadmin',
  description: 'Acesso total',
  isSystem: true,
};

describe('RbacService — imutabilidade de is_system', () => {
  it('renomear papel is_system dispara papel-imutavel', async () => {
    const svc = criarRbacService({
      papeis: fakePapeis([PAPEL_SISTEMA]),
      permissoes: fakePermissoes(),
      associacoes: fakeAssociacoes(),
    });
    await expect(svc.atualizarPapel('sys', { name: 'outro' })).rejects.toMatchObject({
      codigo: 'papel-imutavel',
    });
  });

  it('remover papel is_system dispara papel-imutavel', async () => {
    const svc = criarRbacService({
      papeis: fakePapeis([PAPEL_SISTEMA]),
      permissoes: fakePermissoes(),
      associacoes: fakeAssociacoes(),
    });
    await expect(svc.removerPapel('sys')).rejects.toMatchObject({ codigo: 'papel-imutavel' });
  });

  it('remover permissão is_system dispara permissao-imutavel', async () => {
    const permSistema: Permissao = { id: 'ps', name: '*', description: null, isSystem: true };
    const svc = criarRbacService({
      papeis: fakePapeis(),
      permissoes: fakePermissoes([permSistema]),
      associacoes: fakeAssociacoes(),
    });
    await expect(svc.removerPermissao('ps')).rejects.toMatchObject({
      codigo: 'permissao-imutavel',
    });
  });
});

describe('RbacService — inexistente e composição', () => {
  it('obterPapel de id inexistente dispara papel-nao-encontrado', async () => {
    const svc = criarRbacService({
      papeis: fakePapeis(),
      permissoes: fakePermissoes(),
      associacoes: fakeAssociacoes(),
    });
    await expect(svc.obterPapel('nao-existe')).rejects.toBeInstanceOf(ErroDeRbac);
  });

  it('obterPapel compõe o papel com suas permissões', async () => {
    const papel: Papel = { id: 'r1', name: 'admin', description: null, isSystem: false };
    const svc = criarRbacService({
      papeis: fakePapeis([papel]),
      permissoes: fakePermissoes(),
      associacoes: fakeAssociacoes(['users:read', 'users:write']),
    });
    const resultado = await svc.obterPapel('r1');
    expect(resultado).toMatchObject({ name: 'admin', permissions: ['users:read', 'users:write'] });
  });

  it('atualizarPapel preserva a description quando o patch não a informa', async () => {
    const papel: Papel = { id: 'r2', name: 'x', description: 'mantém', isSystem: false };
    const svc = criarRbacService({
      papeis: fakePapeis([papel]),
      permissoes: fakePermissoes(),
      associacoes: fakeAssociacoes(),
    });
    const atualizado = await svc.atualizarPapel('r2', { name: 'y' });
    expect(atualizado).toMatchObject({ name: 'y', description: 'mantém' });
  });
});
