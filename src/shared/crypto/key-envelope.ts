/**
 * Responsabilidade: cifrar/decifrar segredo em repouso (envelope local AES-256-GCM).
 * Consumido por: o serviço de chaves (decifra a privada ativa no boot), o script de
 * bootstrap (cifra na geração) e o MFA (segredo TOTP, que precisa voltar em claro para
 * gerar o código e por isso é cifra, não hash).
 * Regras:
 *  - Formato do blob: `salt(32) || iv(12) || authTag(16) || ciphertext`.
 *  - Chave AES-256 (32B) derivada da `MASTER_KEY` por `scrypt`, com salt POR SEGREDO — dois
 *    segredos nunca compartilham a mesma chave de cifra.
 *  - Parâmetros de custo FIXOS neste módulo (não vêm de env): mudar o custo tornaria o que
 *    já foi cifrado indecifrável. Espelham o baseline do hash de senha (N=2^15, r=8, p=1).
 *  - `decifrarSegredo` propaga o erro do GCM quando a tag não confere: material adulterado
 *    ou `MASTER_KEY` errada falha alto, nunca devolve lixo silencioso.
 *
 * ponytail: a derivação roda a cada chamada (~100 ms, 64 MiB). No boot de chaves isso
 * acontece uma vez; na verificação de MFA, uma vez por tentativa — aceitável porque é
 * caminho de login, atrás de senha correta e de rate limit. Memoizar por salt se o p95
 * apertar.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Custo do scrypt para derivar a chave de cifra. FIXO de propósito (ver cabeçalho):
// N=2^15, r=8, p=1.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// ~128·N·r·2 = 64 MiB; o teto default do Node (32 MiB) faria o scrypt abortar intermitente.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

const TAMANHO_SALT = 32;
const TAMANHO_IV = 12;
const TAMANHO_TAG = 16;
const TAMANHO_CHAVE = 32; // AES-256
const CABECALHO = TAMANHO_SALT + TAMANHO_IV + TAMANHO_TAG;

function derivarChave(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, TAMANHO_CHAVE, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Cifra bytes quaisquer e devolve o blob `salt||iv||tag||ciphertext`. */
export function cifrarSegredo(segredo: Buffer, masterKey: string): Buffer {
  const salt = randomBytes(TAMANHO_SALT);
  const iv = randomBytes(TAMANHO_IV);
  const chave = derivarChave(masterKey, salt);

  const cipher = createCipheriv('aes-256-gcm', chave, iv);
  const ciphertext = Buffer.concat([cipher.update(segredo), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, ciphertext]);
}

/**
 * Decifra o blob e devolve os bytes originais.
 * @throws quando a tag GCM não confere (blob adulterado ou `MASTER_KEY` errada) ou o blob
 *         é curto demais para conter o cabeçalho.
 */
export function decifrarSegredo(blob: Buffer, masterKey: string): Buffer {
  if (blob.length <= CABECALHO) {
    throw new Error('envelope de chave inválido: blob menor que o cabeçalho');
  }

  const salt = blob.subarray(0, TAMANHO_SALT);
  const iv = blob.subarray(TAMANHO_SALT, TAMANHO_SALT + TAMANHO_IV);
  const tag = blob.subarray(TAMANHO_SALT + TAMANHO_IV, CABECALHO);
  const ciphertext = blob.subarray(CABECALHO);

  const chave = derivarChave(masterKey, salt);
  const decipher = createDecipheriv('aes-256-gcm', chave, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Nomes originais, de quando o envelope só guardava chave privada.
 *
 * Mantidos porque o serviço de chaves e o bootstrap falam de chave privada em PKCS#8 DER, e
 * renomeá-los ali só trocaria um vocabulário correto por um genérico.
 */
export const cifrarPrivada = cifrarSegredo;
export const decifrarPrivada = decifrarSegredo;
