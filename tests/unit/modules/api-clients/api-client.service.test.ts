/**
 * Cobre a administração de clientes com repositório falso: o segredo em claro que sai uma
 * única vez, a resolução de escopos antes de qualquer escrita, e os erros de domínio que o
 * controller traduz para RFC 7807.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarApiClientService,
  type ApiClientService,
} from '../../../../src/modules/api-clients/services/api-client.service.js';
import { ErroDeCliente } from '../../../../src/modules/api-clients/errors/api-client.errors.js';
import { criarServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';
import type { RepositorioDeClientes } from '../../../../src/modules/api-clients/repositories/api-client.repository.js';
import type { ClienteDeApi } from '../../../../src/modules/api-clients/types/api-client.types.js';

const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
const logger = criarLogger({ nivel: 'fatal' });

function clienteFalso(campos: Partial<ClienteDeApi> = {}): ClienteDeApi {
  return {
    id: 'id-1',
    clientId: 'cli_publico',
    name: 'faturamento',
    description: null,
    status: 'active',
    escopos: ['orders:read'],
    grantTypes: ['client_credentials'],
    accessTokenTtlSegundos: null,
    criadoEm: new Date(),
    atualizadoEm: new Date(),
    ultimoUsoEm: null,
    segredoRotacionadoEm: null,
    segredoAnteriorExpiraEm: null,
    ...campos,
  };
}

let repo: {
  criar: ReturnType<typeof vi.fn>;
  buscarPorId: ReturnType<typeof vi.fn>;
  atualizar: ReturnType<typeof vi.fn>;
  removerLogicamente: ReturnType<typeof vi.fn>;
  rotacionarSegredo: ReturnType<typeof vi.fn>;
  revogarSegredoAnterior: ReturnType<typeof vi.fn>;
};
let escopos: { resolver: ReturnType<typeof vi.fn> };
let service: ApiClientService;

function montar(): void {
  repo = {
    criar: vi.fn(() => Promise.resolve(clienteFalso())),
    buscarPorId: vi.fn(() => Promise.resolve(clienteFalso())),
    atualizar: vi.fn(() => Promise.resolve(clienteFalso({ name: 'novo' }))),
    removerLogicamente: vi.fn(() => Promise.resolve(true)),
    rotacionarSegredo: vi.fn(() =>
      Promise.resolve({
        clientId: 'cli_publico',
        segredoRotacionadoEm: new Date(),
        segredoAnteriorExpiraEm: new Date(Date.now() + 3600_000),
      }),
    ),
    revogarSegredoAnterior: vi.fn(() => Promise.resolve(true)),
  };
  escopos = { resolver: vi.fn(() => Promise.resolve(['perm-1'])) };

  service = criarApiClientService({
    repo: repo as unknown as RepositorioDeClientes,
    escopos,
    servicoDeSenha,
    logger,
    sobreposicaoPadraoMs: 86_400_000,
  });
}

beforeEach(montar);

describe('criar', () => {
  it('devolve o segredo em claro e persiste apenas o hash', async () => {
    const { segredo } = await service.criar({
      name: 'faturamento',
      scopes: ['orders:read'],
      grantTypes: ['client_credentials'],
    });

    expect(segredo).toHaveLength(43);
    const persistido = repo.criar.mock.calls[0]?.[0] as { secretHash: string };
    expect(persistido.secretHash).not.toContain(segredo);
    expect(persistido.secretHash.startsWith('scrypt$')).toBe(true);
    expect(await servicoDeSenha.verificar(segredo, persistido.secretHash)).toBe(true);
  });

  // Escopo inválido não deve consumir entropia nem deixar rastro de um cliente inexistente.
  it('resolve os escopos antes de gerar credencial ou escrever', async () => {
    escopos.resolver.mockRejectedValueOnce(new ErroDeCliente('escopo-desconhecido', ['x:y']));

    await expect(
      service.criar({ name: 'x', scopes: ['x:y'], grantTypes: ['client_credentials'] }),
    ).rejects.toMatchObject({ codigo: 'escopo-desconhecido' });

    expect(repo.criar).not.toHaveBeenCalled();
  });

  it('traduz a violação de unicidade em nome já em uso', async () => {
    repo.criar.mockRejectedValueOnce(Object.assign(new Error('duplicado'), { code: '23505' }));

    await expect(
      service.criar({ name: 'repetido', scopes: [], grantTypes: ['client_credentials'] }),
    ).rejects.toMatchObject({ codigo: 'nome-em-uso' });
  });

  it('gera um segredo diferente a cada criação', async () => {
    const a = await service.criar({ name: 'a', scopes: [], grantTypes: ['client_credentials'] });
    const b = await service.criar({ name: 'b', scopes: [], grantTypes: ['client_credentials'] });

    expect(a.segredo).not.toBe(b.segredo);
  });
});

describe('atualizar', () => {
  it('só resolve escopos quando eles são informados', async () => {
    await service.atualizar('id-1', { name: 'novo' });

    expect(escopos.resolver).not.toHaveBeenCalled();
    expect((repo.atualizar.mock.calls[0]?.[1] as Record<string, unknown>)['permissionIds']).toBe(
      undefined,
    );
  });

  it('repassa os ids resolvidos quando os escopos mudam', async () => {
    await service.atualizar('id-1', { scopes: ['orders:read'] });

    expect((repo.atualizar.mock.calls[0]?.[1] as Record<string, unknown>)['permissionIds']).toEqual(
      ['perm-1'],
    );
  });

  it('recusa cliente inexistente', async () => {
    repo.buscarPorId.mockResolvedValueOnce(null);

    await expect(service.atualizar('sumiu', { name: 'x' })).rejects.toMatchObject({
      codigo: 'cliente-nao-encontrado',
    });
  });

  it('recusa cliente já removido', async () => {
    repo.buscarPorId.mockResolvedValueOnce(clienteFalso({ status: 'deleted' }));

    await expect(service.atualizar('id-1', { name: 'x' })).rejects.toMatchObject({
      codigo: 'cliente-ja-removido',
    });
  });
});

describe('remover', () => {
  it('remove logicamente', async () => {
    await service.remover('id-1');

    expect(repo.removerLogicamente).toHaveBeenCalledWith('id-1');
  });

  it('recusa remover duas vezes', async () => {
    repo.buscarPorId.mockResolvedValueOnce(clienteFalso({ status: 'deleted' }));

    await expect(service.remover('id-1')).rejects.toMatchObject({
      codigo: 'cliente-ja-removido',
    });
  });

  // A leitura passou e o UPDATE não casou: outra requisição removeu no meio.
  it('recusa quando outra requisição remove no intervalo', async () => {
    repo.removerLogicamente.mockResolvedValueOnce(false);

    await expect(service.remover('id-1')).rejects.toMatchObject({
      codigo: 'cliente-ja-removido',
    });
  });
});

describe('rotacionarSegredo', () => {
  it('devolve o segredo novo em claro e usa a janela padrão', async () => {
    const resultado = await service.rotacionarSegredo('id-1', undefined);

    expect(resultado.segredo).toHaveLength(43);
    expect(repo.rotacionarSegredo.mock.calls[0]?.[1]).toMatchObject({
      sobreposicaoMs: 86_400_000,
    });
  });

  it('respeita a janela informada, inclusive zero', async () => {
    await service.rotacionarSegredo('id-1', 0);

    expect(repo.rotacionarSegredo.mock.calls[0]?.[1]).toMatchObject({ sobreposicaoMs: 0 });
  });

  it('recusa rotacionar cliente removido', async () => {
    repo.buscarPorId.mockResolvedValueOnce(clienteFalso({ status: 'deleted' }));

    await expect(service.rotacionarSegredo('id-1', undefined)).rejects.toMatchObject({
      codigo: 'cliente-ja-removido',
    });
  });
});

describe('revogarSegredoAnterior', () => {
  it('encerra a sobreposição', async () => {
    await expect(service.revogarSegredoAnterior('id-1')).resolves.toBeUndefined();
  });

  it('recusa quando não havia sobreposição', async () => {
    repo.revogarSegredoAnterior.mockResolvedValueOnce(false);

    await expect(service.revogarSegredoAnterior('id-1')).rejects.toMatchObject({
      codigo: 'sem-segredo-anterior',
    });
  });
});
