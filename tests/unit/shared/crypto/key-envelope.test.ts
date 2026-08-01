/**
 * Cobre o envelope de cifra da privada: round-trip cifra→decifra, salt por chamada, e a
 * falha alta quando a tag GCM é adulterada ou a MASTER_KEY está errada.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { cifrarPrivada, decifrarPrivada } from '../../../../src/shared/crypto/key-envelope.js';

const MASTER = 'chave-mestra-de-teste-com-32-bytes!!';

/** Uma privada Ed25519 real em PKCS#8 DER. */
function privadaDer(): Buffer {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' });
}

describe('cifrarPrivada / decifrarPrivada', () => {
  it('faz round-trip: decifra devolve exatamente a privada cifrada', () => {
    const der = privadaDer();
    const blob = cifrarPrivada(der, MASTER);

    expect(blob.equals(der)).toBe(false); // ciphertext não é o plaintext
    expect(decifrarPrivada(blob, MASTER).equals(der)).toBe(true);
  });

  it('usa salt distinto por chamada — dois blobs da mesma privada diferem', () => {
    const der = privadaDer();
    const a = cifrarPrivada(der, MASTER);
    const b = cifrarPrivada(der, MASTER);

    expect(a.equals(b)).toBe(false);
    // ...mas ambos decifram para a mesma privada.
    expect(decifrarPrivada(a, MASTER).equals(der)).toBe(true);
    expect(decifrarPrivada(b, MASTER).equals(der)).toBe(true);
  });

  it('falha alto quando a tag GCM é adulterada', () => {
    const blob = cifrarPrivada(privadaDer(), MASTER);
    // Vira um bit no ciphertext (após salt+iv+tag = 60 bytes).
    blob.writeUInt8(blob.readUInt8(60) ^ 0x01, 60);

    expect(() => decifrarPrivada(blob, MASTER)).toThrow();
  });

  it('falha alto quando a MASTER_KEY está errada', () => {
    const blob = cifrarPrivada(privadaDer(), MASTER);
    expect(() => decifrarPrivada(blob, 'outra-chave-mestra-completamente-x')).toThrow();
  });

  it('rejeita blob curto demais para conter o cabeçalho', () => {
    expect(() => decifrarPrivada(Buffer.alloc(10), MASTER)).toThrow();
  });
});
