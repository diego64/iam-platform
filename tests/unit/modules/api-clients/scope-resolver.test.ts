/**
 * Cobre o resolvedor de escopos: a recusa do curinga, a recusa do que não existe no
 * catálogo — com a lista do que faltou — e a tradução para ids.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  criarResolvedorDeEscopos,
  type ResolvedorDeEscopos,
} from '../../../../src/modules/api-clients/services/scope-resolver.js';
import { ErroDeCliente } from '../../../../src/modules/api-clients/errors/api-client.errors.js';
import type { CatalogoDeEscopos } from '../../../../src/modules/api-clients/repositories/scope-catalog.repository.js';

/** Catálogo falso com os nomes informados, cada um mapeado para um id previsível. */
function catalogo(nomes: string[]): CatalogoDeEscopos {
  return {
    idsPorNome: (pedidos) =>
      Promise.resolve(new Map(pedidos.filter((n) => nomes.includes(n)).map((n) => [n, `id-${n}`]))),
  };
}

function resolvedor(nomes: string[]): ResolvedorDeEscopos {
  return criarResolvedorDeEscopos(catalogo(nomes));
}

describe('resolver', () => {
  it('traduz os nomes para os ids do catálogo', async () => {
    const ids = await resolvedor(['orders:read', 'orders:write']).resolver([
      'orders:read',
      'orders:write',
    ]);

    expect(ids).toEqual(['id-orders:read', 'id-orders:write']);
  });

  it('aceita lista vazia sem consultar o catálogo', async () => {
    const idsPorNome = vi.fn(() => Promise.resolve(new Map<string, string>()));

    const ids = await criarResolvedorDeEscopos({ idsPorNome }).resolver([]);

    expect(ids).toEqual([]);
    expect(idsPorNome).toHaveBeenCalledWith([]);
  });

  it('trata duplicata como conjunto, não como erro', async () => {
    const ids = await resolvedor(['orders:read']).resolver(['orders:read', 'orders:read']);

    expect(ids).toEqual(['id-orders:read']);
  });
});

describe('recusas', () => {
  // Ignorar o desconhecido criaria um cliente que parece ter a autoridade pedida e não tem.
  it('recusa escopo que não existe no catálogo, dizendo qual faltou', async () => {
    const erro = await resolvedor(['orders:read'])
      .resolver(['orders:read', 'faturas:emitir', 'nao:existe'])
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ErroDeCliente);
    expect((erro as ErroDeCliente).codigo).toBe('escopo-desconhecido');
    expect((erro as ErroDeCliente).escoposDesconhecidos).toEqual(['faturas:emitir', 'nao:existe']);
  });

  // Um cliente com o curinga passaria por qualquer verificação do guard, e clientes não têm
  // nem sessão nem MFA para sustentar esse nível de poder.
  it('recusa o curinga mesmo que ele exista no catálogo', async () => {
    await expect(resolvedor(['*']).resolver(['*'])).rejects.toMatchObject({
      codigo: 'curinga-proibido',
    });
  });

  it('recusa o curinga misturado a escopos legítimos', async () => {
    await expect(
      resolvedor(['orders:read', '*']).resolver(['orders:read', '*']),
    ).rejects.toMatchObject({ codigo: 'curinga-proibido' });
  });

  it('checa o curinga antes de ir ao catálogo', async () => {
    const idsPorNome = vi.fn(() => Promise.resolve(new Map<string, string>()));

    await expect(criarResolvedorDeEscopos({ idsPorNome }).resolver(['*'])).rejects.toThrow();

    expect(idsPorNome).not.toHaveBeenCalled();
  });
});
