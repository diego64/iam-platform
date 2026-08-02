/**
 * A gramática da condição é a fronteira entre "dado administrável" e "superfície de
 * execução". Este teste fixa o que ela aceita e, principalmente, o que recusa: operador
 * fora da whitelist, campo extra e árvore além dos limites de forma (anti-DoS, RF-11).
 */
import { describe, expect, it } from 'vitest';
import { condicaoSchema } from '../../../../src/modules/abac/schemas/condition.schema.js';
import {
  LIMITE_DE_NOS,
  LIMITE_DE_PROFUNDIDADE,
  medirCondicao,
} from '../../../../src/modules/abac/validators/condition-limits.js';

/** Aninha `not` até `niveis` de profundidade. */
function aninhar(niveis: number): unknown {
  let no: unknown = { op: 'eq', attr: 'subject.sub', value: 'u-1' };
  for (let i = 1; i < niveis; i += 1) no = { op: 'not', of: [no] };
  return no;
}

describe('gramática da condição', () => {
  it('aceita comparação com literal e com referência entre atributos', () => {
    expect(
      condicaoSchema.safeParse({ op: 'eq', attr: 'resource.owner_id', value: 'u-1' }).success,
    ).toBe(true);
    expect(
      condicaoSchema.safeParse({
        op: 'eq',
        attr: 'resource.owner_id',
        value: { ref: 'subject.sub' },
      }).success,
    ).toBe(true);
  });

  it('aceita in, contains e os lógicos', () => {
    const condicao = {
      op: 'and',
      of: [
        { op: 'in', attr: 'action', value: ['read', 'list'] },
        { op: 'contains', attr: 'subject.roles', value: 'operator' },
        { op: 'not', of: [{ op: 'ne', attr: 'resource.type', value: 'user' }] },
      ],
    };
    expect(condicaoSchema.safeParse(condicao).success).toBe(true);
  });

  it('recusa operador fora da whitelist', () => {
    expect(
      condicaoSchema.safeParse({ op: 'regex', attr: 'resource.name', value: '^a' }).success,
    ).toBe(false);
    expect(condicaoSchema.safeParse({ op: 'eval', of: [] }).success).toBe(false);
  });

  it('recusa campo extra no nó (strict)', () => {
    expect(
      condicaoSchema.safeParse({ op: 'eq', attr: 'subject.sub', value: 'u-1', extra: true })
        .success,
    ).toBe(false);
  });

  it('recusa `not` com número de filhos diferente de um', () => {
    const um = { op: 'eq', attr: 'subject.sub', value: 'u-1' };
    expect(condicaoSchema.safeParse({ op: 'not', of: [] }).success).toBe(false);
    expect(condicaoSchema.safeParse({ op: 'not', of: [um, um] }).success).toBe(false);
  });

  it('aceita exatamente o limite de profundidade e recusa um nível além', () => {
    expect(condicaoSchema.safeParse(aninhar(LIMITE_DE_PROFUNDIDADE)).success).toBe(true);
    expect(condicaoSchema.safeParse(aninhar(LIMITE_DE_PROFUNDIDADE + 1)).success).toBe(false);
  });

  it('recusa árvore com nós demais', () => {
    const folhas = Array.from({ length: LIMITE_DE_NOS }, () => ({
      op: 'eq',
      attr: 'subject.sub',
      value: 'u-1',
    }));
    expect(condicaoSchema.safeParse({ op: 'or', of: folhas }).success).toBe(false);
  });

  it('mede árvore profunda sem estourar a pilha', () => {
    const { profundidade } = medirCondicao(aninhar(50_000));
    expect(profundidade).toBeGreaterThan(LIMITE_DE_PROFUNDIDADE);
  });
});
