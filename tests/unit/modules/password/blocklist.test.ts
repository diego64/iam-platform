/**
 * Cobre a blocklist de senhas comuns: pega as da lista (inclusive com variação de caixa e
 * espaço) e deixa passar as que não estão.
 */
import { describe, expect, it } from 'vitest';
import { estaNaBlocklist } from '../../../../src/modules/password/constants/blocklist.js';

describe('estaNaBlocklist', () => {
  it.each(['password', '123456', 'qwerty', 'senha123'])('bloqueia a senha comum %j', (senha) => {
    expect(estaNaBlocklist(senha)).toBe(true);
  });

  it('normaliza caixa e espaço — Password e "  senha " também são bloqueadas', () => {
    expect(estaNaBlocklist('Password')).toBe(true);
    expect(estaNaBlocklist('  senha ')).toBe(true);
  });

  it.each(['N0v@Senh@Forte!', 'correta-horse-battery', 'x9K2mLpQ7w'])(
    'deixa passar a senha fora da lista %j',
    (senha) => {
      expect(estaNaBlocklist(senha)).toBe(false);
    },
  );
});
