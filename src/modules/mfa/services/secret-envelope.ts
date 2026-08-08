/**
 * Responsabilidade: decifrar o segredo de um fator, transformando falha de decifragem em
 * erro de domínio.
 * Consumido por: o serviço de MFA e o de desafio.
 * Regras:
 *  - A decifragem falha alto quando a `MASTER_KEY` mudou ou o blob foi adulterado. Deixar o
 *    erro do GCM subir cru viraria 500 com mensagem de biblioteca; aqui ele vira "código
 *    inválido", que é o que o usuário pode agir a respeito — e o motivo real fica no log de
 *    quem chama.
 */
import { decifrarSegredo } from '../../../shared/crypto/key-envelope.js';
import { ErroDeMfa } from '../errors/mfa-error.js';

export function decifrarSegredoDoFator(blob: Buffer, masterKey: string): Buffer {
  try {
    return decifrarSegredo(blob, masterKey);
  } catch {
    throw new ErroDeMfa('codigo-invalido');
  }
}
