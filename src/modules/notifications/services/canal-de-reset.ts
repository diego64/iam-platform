/**
 * Responsabilidade: entregar o token de reset ao usuário — o concreto que faltava para a
 * porta `CanalDeNotificacao` da SPEC 009.
 * Consumido por: a composição, no lugar do log-fallback.
 * Regras:
 *  - A porta recebe o token em claro porque este é o único ponto autorizado a vê-lo: o que
 *    persiste é sempre o sha256. Daqui ele vai para o link e para lugar nenhum mais.
 *  - **Não lança.** O `PasswordService` chama isto no meio do fluxo de reset; uma exceção
 *    aqui abortaria a rotina depois de o token já estar gravado.
 *  - Perder esta mensagem é o caso mais benigno de perda desta SPEC: o usuário pede de novo,
 *    e o token antigo expira sozinho.
 */
import type { CanalDeNotificacao } from '../../password/interfaces/notificacao.port.js';
import type { ServicoDeNotificacao } from './notification.service.js';
import { resetDeSenha } from './templates.js';

export interface OpcoesDoCanalDeReset {
  readonly notificacoes: ServicoDeNotificacao;
  /** Base do link — a página que coleta a senha nova vive fora deste serviço. */
  readonly urlDeReset: string;
  readonly validadeMin: number;
}

export function criarCanalDeReset(opcoes: OpcoesDoCanalDeReset): CanalDeNotificacao {
  return {
    async enviarReset(email: string, token: string): Promise<void> {
      await opcoes.notificacoes.enviar({
        tipo: 'reset_de_senha',
        para: [email],
        corpo: resetDeSenha(opcoes.urlDeReset, token, opcoes.validadeMin),
      });
    },
  };
}
