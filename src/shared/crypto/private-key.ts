/**
 * Responsabilidade: encapsular a chave privada de assinatura já decifrada, garantindo que
 * ela nunca vaze por serialização acidental (log, JSON de erro, inspeção).
 * Consumido por: o serviço de chaves, que a entrega ao serviço de emissão de tokens para
 * assinar.
 * Regras:
 *  - O material fica num campo privado (`#chave`): `JSON.stringify` e `util.inspect` já o
 *    ignoram por construção. `toJSON`/`[inspect.custom]` reforçam com `'[REDACTED]'` e dão
 *    um alvo explícito ao teste anti-vazamento.
 *  - Só `usar()` devolve a `KeyObject` — quem assina pega a chave no último instante, sem
 *    ela transitar por objetos logáveis.
 */
import { inspect } from 'node:util';
import type { KeyObject } from 'node:crypto';

const CENSURA = '[REDACTED]';

export class ChavePrivada {
  readonly #chave: KeyObject;

  constructor(chave: KeyObject) {
    this.#chave = chave;
  }

  /** Devolve a `KeyObject` para uso imediato na assinatura. Não a guarde em objeto logável. */
  usar(): KeyObject {
    return this.#chave;
  }

  /** Censura em `JSON.stringify`. */
  toJSON(): string {
    return CENSURA;
  }

  /** Censura em template string / concatenação. */
  toString(): string {
    return CENSURA;
  }

  /** Censura em `util.inspect` / `console.log`. */
  [inspect.custom](): string {
    return CENSURA;
  }
}
