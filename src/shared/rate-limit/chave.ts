/**
 * Responsabilidade: derivar a chave do contador a partir da dimensão e do identificador.
 * Consumido por: a política de limite e os hooks que a chamam.
 * Regras:
 *  - O identificador nunca vai em claro para o contador. A coleção seria, sem isso, uma
 *    segunda base de e-mails — com retenção própria e sem a proteção que a tabela de usuários
 *    tem. O mesmo vale para IP e `client_id`.
 *  - O pepper é o mesmo da trilha de auditoria: a derivação precisa ser estável entre
 *    instâncias e reiniciável sem perder a contagem no meio de uma janela.
 *  - A dimensão entra na entrada do hash, não como prefixo do resultado: com o prefixo, o
 *    mesmo valor em duas dimensões produziria o mesmo digest e as cotas se misturariam.
 */
import { createHash } from 'node:crypto';
import type { DimensaoDeLimite } from './types.js';

/**
 * Normaliza antes de derivar: e-mail digitado com caixa diferente é a mesma conta, e sem isso
 * `Admin@iam.local` teria cota própria separada de `admin@iam.local`.
 */
function normalizar(valor: string): string {
  return valor.trim().toLowerCase();
}

export function derivarChave(dimensao: DimensaoDeLimite, valor: string, pepper: string): string {
  const digest = createHash('sha256')
    .update(`${dimensao}:${normalizar(valor)}:${pepper}`, 'utf8')
    .digest('hex');
  // O prefixo legível fica **fora** do material hasheado: serve para depurar a coleção e para
  // expurgo manual por dimensão, sem devolver nada sobre o identificador.
  return `${dimensao}:${digest}`;
}
