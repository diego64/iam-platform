/**
 * Cobre o gerador de credenciais: formato, entropia e ausência de colisão. O segredo é a
 * única barreira entre um estranho e a autoridade do cliente, então o tamanho não é detalhe
 * de estilo — é o fator de trabalho de quem tentar adivinhá-lo.
 */
import { describe, expect, it } from 'vitest';
import {
  gerarClientId,
  gerarSegredo,
} from '../../../../src/modules/api-clients/services/credential-factory.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('gerarClientId', () => {
  it('usa o prefixo que identifica o valor num log ou num ticket', () => {
    expect(gerarClientId().startsWith('cli_')).toBe(true);
  });

  it('carrega 128 bits em 22 caracteres base64url', () => {
    const corpo = gerarClientId().slice('cli_'.length);

    expect(corpo).toHaveLength(22);
    expect(corpo).toMatch(BASE64URL);
  });

  it('não colide numa amostra grande', () => {
    const gerados = new Set(Array.from({ length: 5000 }, () => gerarClientId()));

    expect(gerados.size).toBe(5000);
  });
});

describe('gerarSegredo', () => {
  it('carrega 256 bits em 43 caracteres base64url', () => {
    const segredo = gerarSegredo();

    expect(segredo).toHaveLength(43);
    expect(segredo).toMatch(BASE64URL);
  });

  // base64url não usa `+`, `/` nem `=`: o segredo viaja em header e corpo sem escape.
  it('não produz caractere que precise de escape em transporte', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(gerarSegredo()).not.toMatch(/[+/=]/);
    }
  });

  it('não colide numa amostra grande', () => {
    const gerados = new Set(Array.from({ length: 5000 }, () => gerarSegredo()));

    expect(gerados.size).toBe(5000);
  });

  it('não repete o identificador — são valores independentes', () => {
    expect(gerarSegredo()).not.toBe(gerarClientId());
  });
});
