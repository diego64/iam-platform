/**
 * Responsabilidade: gerar o identificador público e o segredo de um cliente de API.
 * Consumido por: o serviço de clientes, na criação e na rotação de segredo.
 * Regras:
 *  - Ambos vêm de `randomBytes`. O identificador é público e só precisa ser impossível de
 *    adivinhar em massa; o segredo é credencial e leva 256 bits.
 *  - O segredo em claro existe apenas no retorno desta função e na única resposta HTTP que
 *    o entrega. Nada aqui o persiste, loga ou guarda.
 */
import { randomBytes } from 'node:crypto';

/** Prefixo do identificador — torna óbvio, num log ou num ticket, o que é aquele valor. */
const PREFIXO = 'cli_';
const BYTES_DO_ID = 16;
const BYTES_DO_SEGREDO = 32;

/** Identificador público do cliente: `cli_` + 22 caracteres base64url (128 bits). */
export function gerarClientId(): string {
  return PREFIXO + randomBytes(BYTES_DO_ID).toString('base64url');
}

/**
 * Segredo do cliente: 43 caracteres base64url (256 bits).
 *
 * A entropia é o que sustenta o cliente contra força bruta — o `scrypt` protege o hash em
 * repouso, não o segredo em si.
 */
export function gerarSegredo(): string {
  return randomBytes(BYTES_DO_SEGREDO).toString('base64url');
}
