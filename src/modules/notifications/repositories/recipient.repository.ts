/**
 * Responsabilidade: o e-mail de um usuário, a partir do id — o concreto da porta de
 * destinatário.
 * Consumido por: o serviço de notificação.
 * Regras:
 *  - Recebe o `Pool` por injeção; nunca importa singleton de conexão.
 *  - **Uma coluna.** Não é o repositório da SPEC 002 de propósito: aquele devolve
 *    `password_hash` junto, e o módulo que conversa com um provedor externo não tem por que
 *    enxergá-lo. Coluna nova na tabela também não vaza sozinha para cá.
 *  - Falha de consulta devolve `null` — o serviço trata como "não sei para quem mandar" e
 *    conta a supressão. Derrubar a notificação por causa de um `SELECT` seria trocar um aviso
 *    perdido por uma exceção solta fora do caminho da requisição.
 */
import type { Pool } from 'pg';
import type { ResolvedorDeDestinatario } from '../interfaces/destinatario.port.js';

interface LinhaDeEmail {
  readonly email: string;
}

export interface OpcoesDoResolvedor {
  readonly pool: Pool;
  readonly aoFalhar?: (erro: unknown) => void;
}

export function criarResolvedorDeDestinatario(
  opcoes: OpcoesDoResolvedor,
): ResolvedorDeDestinatario {
  return {
    async emailDe(userId: string): Promise<string | null> {
      try {
        const resultado = await opcoes.pool.query<LinhaDeEmail>(
          'SELECT email FROM users WHERE id = $1',
          [userId],
        );

        return resultado.rows[0]?.email ?? null;
      } catch (erro) {
        opcoes.aoFalhar?.(erro);
        return null;
      }
    },
  };
}
