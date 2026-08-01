/**
 * Responsabilidade: gerar UUIDv7 (RFC 9562) — identificador único ordenável por tempo.
 * Consumido por: o `kid` das chaves de assinatura e o `jti` dos tokens.
 * Regras:
 *  - 48 bits de timestamp Unix em ms no topo ⇒ ordenação cronológica por comparação de
 *    string, útil para escolher a chave mais nova e para range queries.
 *  - Os 74 bits restantes vêm de `randomBytes` — colisão praticamente impossível dentro
 *    do mesmo milissegundo.
 *  - Sem dependência: `crypto.randomUUID` do Node só emite v4 (sem componente temporal).
 */
import { randomBytes } from 'node:crypto';

/** Gera um UUIDv7 em formato canônico (`xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`). */
export function uuidv7(): string {
  const bytes = randomBytes(16);

  // 48 bits de timestamp big-endian nos bytes 0..5. `writeUIntBE` aceita até 48 bits, e
  // `Date.now()` (~41 bits) cabe com folga.
  bytes.writeUIntBE(Date.now(), 0, 6);

  // Versão 7 no nibble alto do byte 6; variante RFC (10xx) no topo do byte 8.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
