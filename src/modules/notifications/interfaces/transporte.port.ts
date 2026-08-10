/**
 * Porta do transporte de e-mail. Dois concretos: HTTP (produção) e log (desenvolvimento,
 * teste e ambiente que subiu sem provedor).
 * Regras:
 *  - **Devolve resultado, não lança.** Falha de entrega é desfecho esperado, não exceção:
 *    quem chama já está fora do caminho da requisição, e o que ele faz com a falha é contar.
 *  - A causa é do vocabulário fechado. Repassar a mensagem do provedor traria de volta o
 *    destinatário e, no caso do reset, o token — provedor costuma ecoar a requisição no erro.
 */
import type { CausaDeFalha } from '../constants/tipos.js';
import type { MensagemDeEmail } from '../types/mensagem.js';

export type ResultadoDeEntrega =
  { readonly ok: true } | { readonly ok: false; readonly causa: CausaDeFalha };

export interface TransportadorDeEmail {
  enviar(mensagem: MensagemDeEmail): Promise<ResultadoDeEntrega>;
}

/** Transporte que não entrega nada — o de quem não configurou provedor nenhum. */
export function transporteNulo(): TransportadorDeEmail {
  return {
    enviar(): Promise<ResultadoDeEntrega> {
      return Promise.resolve({ ok: false, causa: 'nao_configurado' });
    },
  };
}
