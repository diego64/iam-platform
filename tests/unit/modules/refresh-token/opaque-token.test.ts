/**
 * Cobre o token opaco: formato de 88 caracteres base64, aleatoriedade entre chamadas e o
 * hash sha256 determinístico (o que persiste no lugar do token em claro).
 */
import { describe, expect, it } from 'vitest';
import {
  gerarTokenOpaco,
  digerirToken,
} from '../../../../src/modules/refresh-token/services/opaque-token.js';

describe('gerarTokenOpaco', () => {
  it('gera 88 caracteres base64', () => {
    const token = gerarTokenOpaco();
    expect(token).toHaveLength(88);
    expect(token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('não repete entre chamadas', () => {
    expect(gerarTokenOpaco()).not.toBe(gerarTokenOpaco());
  });
});

describe('digerirToken', () => {
  it('é determinístico e produz sha256 hexadecimal (64 chars)', () => {
    const token = gerarTokenOpaco();
    const hash = digerirToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(digerirToken(token)).toBe(hash);
  });

  it('muda com a entrada', () => {
    expect(digerirToken('a')).not.toBe(digerirToken('b'));
  });
});
