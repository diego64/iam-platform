/**
 * Cobre o gerador de UUIDv7: formato canônico, nibble de versão, bits de variante e a
 * ordenação cronológica (dois ids gerados em momentos distintos ordenam por comparação
 * de string).
 */
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../../../src/shared/crypto/uuidv7.js';

const FORMATO_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produz o formato canônico com versão 7 e variante RFC', () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(FORMATO_V7);
    }
  });

  it('gera identificadores distintos', () => {
    const conjunto = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(conjunto.size).toBe(1000);
  });

  it('ordena cronologicamente por comparação de string', async () => {
    const antes = uuidv7();
    await new Promise((r) => setTimeout(r, 3));
    const depois = uuidv7();
    expect(antes < depois).toBe(true);
  });
});
