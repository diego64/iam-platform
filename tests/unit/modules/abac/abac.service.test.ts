/**
 * O serviço guarda duas regras que o repositório não conhece: política de sistema é
 * intocável, e toda escrita invalida o cache do PDP. A segunda é fácil de esquecer e o
 * sintoma seria uma política nova "não pegando" até o TTL expirar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarAbacService,
  type AbacService,
} from '../../../../src/modules/abac/services/abac.service.js';
import { ErroDeAbac } from '../../../../src/modules/abac/errors/abac.errors.js';
import type { DadosDePolitica } from '../../../../src/modules/abac/repositories/policy.repository.js';
import type { Condicao, Politica } from '../../../../src/modules/abac/types/abac.types.js';

const POSSE: Condicao = { op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } };

function politica(parcial: Partial<Politica> = {}): Politica {
  return {
    id: 'p-1',
    name: 'own-user',
    description: null,
    effect: 'permit',
    resourceType: 'user',
    action: 'read',
    condition: POSSE,
    priority: 0,
    enabled: true,
    isSystem: false,
    ...parcial,
  };
}

function dados(parcial: Partial<DadosDePolitica> = {}): DadosDePolitica {
  return {
    name: 'own-user',
    description: null,
    effect: 'permit',
    resourceType: 'user',
    action: 'read',
    condition: POSSE,
    priority: 0,
    enabled: true,
    ...parcial,
  };
}

let repo: {
  criar: ReturnType<typeof vi.fn>;
  buscarPorId: ReturnType<typeof vi.fn>;
  listar: ReturnType<typeof vi.fn>;
  contar: ReturnType<typeof vi.fn>;
  atualizar: ReturnType<typeof vi.fn>;
  remover: ReturnType<typeof vi.fn>;
  listarAplicaveis: ReturnType<typeof vi.fn>;
};
let invalidar: ReturnType<typeof vi.fn>;
let servico: AbacService;

beforeEach(() => {
  repo = {
    criar: vi.fn().mockResolvedValue(politica()),
    buscarPorId: vi.fn().mockResolvedValue(politica()),
    listar: vi.fn().mockResolvedValue([politica()]),
    contar: vi.fn().mockResolvedValue(1),
    atualizar: vi
      .fn()
      .mockImplementation((_id: string, d: Partial<Politica>) => Promise.resolve(politica(d))),
    remover: vi.fn().mockResolvedValue(true),
    listarAplicaveis: vi.fn().mockResolvedValue([]),
  };
  invalidar = vi.fn();
  servico = criarAbacService({ politicas: repo, motor: { invalidar } });
});

describe('imutabilidade de política de sistema', () => {
  beforeEach(() => {
    repo.buscarPorId.mockResolvedValue(politica({ isSystem: true, name: 'system-ownership' }));
  });

  it('recusa editar', async () => {
    await expect(servico.atualizarPolitica('p-1', { name: 'outro' })).rejects.toMatchObject({
      codigo: 'politica-imutavel',
    });
    expect(repo.atualizar).not.toHaveBeenCalled();
  });

  it('recusa remover', async () => {
    await expect(servico.removerPolitica('p-1')).rejects.toBeInstanceOf(ErroDeAbac);
    expect(repo.remover).not.toHaveBeenCalled();
  });

  it('mas permite ler', async () => {
    await expect(servico.obterPolitica('p-1')).resolves.toMatchObject({ isSystem: true });
  });
});

describe('política inexistente', () => {
  beforeEach(() => {
    repo.buscarPorId.mockResolvedValue(null);
  });

  it('obter, editar e remover devolvem não-encontrada', async () => {
    for (const acao of [
      servico.obterPolitica('x'),
      servico.atualizarPolitica('x', {}),
      servico.removerPolitica('x'),
    ]) {
      await expect(acao).rejects.toMatchObject({ codigo: 'politica-nao-encontrada' });
    }
  });
});

describe('invalidação do cache do PDP', () => {
  it('criar, atualizar e remover invalidam', async () => {
    await servico.criarPolitica(dados());
    expect(invalidar).toHaveBeenCalledTimes(1);

    await servico.atualizarPolitica('p-1', { priority: 5 });
    expect(invalidar).toHaveBeenCalledTimes(2);

    await servico.removerPolitica('p-1');
    expect(invalidar).toHaveBeenCalledTimes(3);
  });

  it('leitura não invalida', async () => {
    await servico.listarPoliticas({ limite: 10, offset: 0 });
    await servico.obterPolitica('p-1');
    expect(invalidar).not.toHaveBeenCalled();
  });

  it('não invalida quando a escrita falha', async () => {
    repo.criar.mockRejectedValue(new ErroDeAbac('politica-conflito'));
    await expect(servico.criarPolitica(dados())).rejects.toBeInstanceOf(ErroDeAbac);
    expect(invalidar).not.toHaveBeenCalled();
  });
});

describe('patch parcial', () => {
  it('preserva os campos não informados', async () => {
    await servico.atualizarPolitica('p-1', { priority: 42 });
    expect(repo.atualizar).toHaveBeenCalledWith('p-1', {
      name: 'own-user',
      description: null,
      effect: 'permit',
      resourceType: 'user',
      action: 'read',
      condition: POSSE,
      priority: 42,
      enabled: true,
    });
  });

  it('distingue description ausente de description nula', async () => {
    repo.buscarPorId.mockResolvedValue(politica({ description: 'antiga' }));
    await servico.atualizarPolitica('p-1', { description: null });
    expect(repo.atualizar).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({ description: null }),
    );

    await servico.atualizarPolitica('p-1', {});
    expect(repo.atualizar).toHaveBeenLastCalledWith(
      'p-1',
      expect.objectContaining({ description: 'antiga' }),
    );
  });
});

describe('revalidação de forma da condição', () => {
  /** Aninha `not` além do limite de profundidade. */
  function profundaDemais(): Condicao {
    let no: Condicao = { op: 'eq', attr: 'subject.sub', value: 'u-1' };
    for (let i = 0; i < 15; i += 1) no = { op: 'not', of: [no] };
    return no;
  }

  it('recusa condição fora dos limites na criação, sem tocar o repositório', async () => {
    await expect(
      servico.criarPolitica(dados({ condition: profundaDemais() })),
    ).rejects.toMatchObject({ codigo: 'condicao-invalida' });
    expect(repo.criar).not.toHaveBeenCalled();
  });

  it('recusa na atualização', async () => {
    await expect(
      servico.atualizarPolitica('p-1', { condition: profundaDemais() }),
    ).rejects.toMatchObject({ codigo: 'condicao-invalida' });
    expect(repo.atualizar).not.toHaveBeenCalled();
  });
});
