/**
 * Cobre o wrapper anti-vazamento `ChavePrivada`: o material da chave nunca aparece em
 * `JSON.stringify`, `util.inspect`, template string ou concatenação. Só `usar()` devolve a
 * KeyObject.
 */
import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { ChavePrivada } from '../../../../src/shared/crypto/private-key.js';

function chaveReal(): KeyObject {
  return generateKeyPairSync('ed25519').privateKey;
}

/** Fragmento da privada em base64 — se vazar por serialização, aparece aqui. */
function segredoDaChave(chave: KeyObject): string {
  return chave.export({ format: 'der', type: 'pkcs8' }).toString('base64').slice(8, 40);
}

describe('ChavePrivada', () => {
  it('censura em JSON.stringify', () => {
    const chave = chaveReal();
    const envolvida = new ChavePrivada(chave);

    const texto = JSON.stringify({ chave: envolvida });
    expect(texto).toContain('[REDACTED]');
    expect(texto).not.toContain(segredoDaChave(chave));
  });

  it('censura em util.inspect / console.log', () => {
    const chave = chaveReal();
    const texto = inspect({ chave: new ChavePrivada(chave) }, { depth: 5 });

    expect(texto).toContain('[REDACTED]');
    expect(texto).not.toContain(segredoDaChave(chave));
  });

  it('censura em coerção para string (toString)', () => {
    const chave = chaveReal();
    const texto = String(new ChavePrivada(chave));

    expect(texto).toBe('[REDACTED]');
    expect(texto).not.toContain(segredoDaChave(chave));
  });

  it('usar() devolve a KeyObject original para assinatura', () => {
    const chave = chaveReal();
    expect(new ChavePrivada(chave).usar()).toBe(chave);
  });
});
