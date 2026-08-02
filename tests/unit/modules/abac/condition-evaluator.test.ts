/**
 * O avaliador decide autorização, então cada operador tem caso positivo e negativo, e os
 * caminhos de fail-closed (atributo ausente, tipos incompatíveis, operador desconhecido)
 * são tão importantes quanto os felizes: um `true` acidental aqui vira acesso concedido.
 */
import { describe, expect, it } from 'vitest';
import {
  avaliarCondicao,
  resolverAtributo,
} from '../../../../src/modules/abac/services/condition-evaluator.js';
import type { Condicao, ContextoDeDecisao } from '../../../../src/modules/abac/types/abac.types.js';

const AGORA = new Date('2026-08-02T12:00:00.000Z');

function contexto(parcial: Partial<ContextoDeDecisao> = {}): ContextoDeDecisao {
  return {
    subject: { sub: 'u-1', roles: ['operator'], perm: ['users:read'] },
    resourceType: 'user',
    resource: { owner_id: 'u-1', type: 'user', nivel: 5, tags: ['a', 'b'] },
    action: 'read',
    env: { ip: '10.0.0.1', now: AGORA },
    ...parcial,
  };
}

function avaliar(condicao: Condicao, ctx: ContextoDeDecisao = contexto()): boolean {
  return avaliarCondicao(condicao, ctx);
}

describe('resolução de atributo', () => {
  it('resolve caminhos de subject, resource, action e env', () => {
    const ctx = contexto();
    expect(resolverAtributo('subject.sub', ctx)).toBe('u-1');
    expect(resolverAtributo('resource.owner_id', ctx)).toBe('u-1');
    expect(resolverAtributo('action', ctx)).toBe('read');
    expect(resolverAtributo('env.ip', ctx)).toBe('10.0.0.1');
    expect(resolverAtributo('subject.roles', ctx)).toEqual(['operator']);
  });

  it('devolve undefined para caminho inexistente ou travessia inválida', () => {
    const ctx = contexto();
    expect(resolverAtributo('resource.inexistente', ctx)).toBeUndefined();
    expect(resolverAtributo('subject.sub.mais.fundo', ctx)).toBeUndefined();
    expect(resolverAtributo('', ctx)).toBeUndefined();
    expect(resolverAtributo('resource..owner_id', ctx)).toBeUndefined();
  });

  it('não alcança a cadeia de protótipos', () => {
    const ctx = contexto();
    expect(resolverAtributo('__proto__', ctx)).toBeUndefined();
    expect(resolverAtributo('resource.__proto__', ctx)).toBeUndefined();
    expect(resolverAtributo('resource.constructor', ctx)).toBeUndefined();
    expect(resolverAtributo('subject.constructor.prototype', ctx)).toBeUndefined();
    expect(resolverAtributo('resource.toString', ctx)).toBeUndefined();
  });
});

describe('operadores de comparação', () => {
  it('eq compara literal e referência entre atributos', () => {
    expect(avaliar({ op: 'eq', attr: 'resource.owner_id', value: 'u-1' })).toBe(true);
    expect(avaliar({ op: 'eq', attr: 'resource.owner_id', value: 'u-2' })).toBe(false);
    expect(avaliar({ op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } })).toBe(
      true,
    );
    expect(
      avaliar(
        { op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } },
        contexto({ resource: { owner_id: 'outro' } }),
      ),
    ).toBe(false);
  });

  it('ne é verdadeiro quando o atributo está ausente', () => {
    expect(avaliar({ op: 'ne', attr: 'resource.owner_id', value: 'u-2' })).toBe(true);
    expect(avaliar({ op: 'ne', attr: 'resource.owner_id', value: 'u-1' })).toBe(false);
    expect(avaliar({ op: 'ne', attr: 'resource.inexistente', value: 'qualquer' })).toBe(true);
  });

  it('eq com atributo ausente é falso', () => {
    expect(avaliar({ op: 'eq', attr: 'resource.inexistente', value: 'qualquer' })).toBe(false);
  });

  it('gt/gte/lt/lte ordenam números', () => {
    expect(avaliar({ op: 'gt', attr: 'resource.nivel', value: 4 })).toBe(true);
    expect(avaliar({ op: 'gt', attr: 'resource.nivel', value: 5 })).toBe(false);
    expect(avaliar({ op: 'gte', attr: 'resource.nivel', value: 5 })).toBe(true);
    expect(avaliar({ op: 'lt', attr: 'resource.nivel', value: 6 })).toBe(true);
    expect(avaliar({ op: 'lte', attr: 'resource.nivel', value: 5 })).toBe(true);
  });

  it('gt/gte/lt/lte ordenam datas contra ISO-8601 (janela de horário)', () => {
    expect(avaliar({ op: 'gt', attr: 'env.now', value: '2026-08-02T08:00:00Z' })).toBe(true);
    expect(avaliar({ op: 'lt', attr: 'env.now', value: '2026-08-02T08:00:00Z' })).toBe(false);
    expect(avaliar({ op: 'lte', attr: 'env.now', value: '2026-08-02T12:00:00.000Z' })).toBe(true);
  });

  it('ordenação sobre tipos incompatíveis é falsa', () => {
    expect(avaliar({ op: 'gt', attr: 'resource.type', value: 'aaa' })).toBe(false);
    expect(avaliar({ op: 'gt', attr: 'subject.roles', value: 1 })).toBe(false);
    expect(avaliar({ op: 'lt', attr: 'resource.inexistente', value: 10 })).toBe(false);
    expect(avaliar({ op: 'gte', attr: 'resource.nivel', value: 'texto' })).toBe(false);
  });
});

describe('pertinência', () => {
  it('in checa o valor do atributo contra a lista', () => {
    expect(avaliar({ op: 'in', attr: 'action', value: ['read', 'list'] })).toBe(true);
    expect(avaliar({ op: 'in', attr: 'action', value: ['delete'] })).toBe(false);
    expect(avaliar({ op: 'in', attr: 'resource.inexistente', value: ['read'] })).toBe(false);
    // Atributo que é array não "pertence" a uma lista de literais.
    expect(avaliar({ op: 'in', attr: 'subject.roles', value: ['operator'] })).toBe(false);
  });

  it('contains exige que o atributo seja array', () => {
    expect(avaliar({ op: 'contains', attr: 'subject.roles', value: 'operator' })).toBe(true);
    expect(avaliar({ op: 'contains', attr: 'subject.perm', value: 'users:write' })).toBe(false);
    expect(avaliar({ op: 'contains', attr: 'resource.tags', value: 'b' })).toBe(true);
    expect(avaliar({ op: 'contains', attr: 'resource.type', value: 'user' })).toBe(false);
  });

  it('contains aceita referência como valor procurado', () => {
    const ctx = contexto({
      subject: { sub: 'a', roles: [], perm: [] },
      resource: { owner_id: 'x', tags: ['a'] },
    });
    expect(
      avaliar({ op: 'contains', attr: 'resource.tags', value: { ref: 'subject.sub' } }, ctx),
    ).toBe(true);
  });
});

describe('operadores lógicos', () => {
  const verdadeiro: Condicao = { op: 'eq', attr: 'subject.sub', value: 'u-1' };
  const falso: Condicao = { op: 'eq', attr: 'subject.sub', value: 'outro' };

  it('and exige todos; or basta um; not inverte', () => {
    expect(avaliar({ op: 'and', of: [verdadeiro, verdadeiro] })).toBe(true);
    expect(avaliar({ op: 'and', of: [verdadeiro, falso] })).toBe(false);
    expect(avaliar({ op: 'or', of: [falso, verdadeiro] })).toBe(true);
    expect(avaliar({ op: 'or', of: [falso, falso] })).toBe(false);
    expect(avaliar({ op: 'not', of: [falso] })).toBe(true);
    expect(avaliar({ op: 'not', of: [verdadeiro] })).toBe(false);
  });

  it('agregador sem filhos não concede acesso', () => {
    expect(avaliar({ op: 'and', of: [] })).toBe(false);
    expect(avaliar({ op: 'or', of: [] })).toBe(false);
    expect(avaliar({ op: 'not', of: [] })).toBe(false);
  });
});

describe('fail closed', () => {
  it('operador fora da gramática resolve false', () => {
    const forjada = { op: 'regex', attr: 'resource.type', value: '.*' } as unknown as Condicao;
    expect(avaliar(forjada)).toBe(false);
  });

  it('condição com attr malicioso nunca polui o protótipo', () => {
    const forjada = {
      op: 'eq',
      attr: '__proto__.polluted',
      value: true,
    } as Condicao;
    expect(avaliar(forjada)).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
