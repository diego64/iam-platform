/**
 * Responsabilidade: canal de notificação de reset em log — o fallback até a 019 entregar
 * e-mail de verdade.
 * Regras:
 *  - **Não loga o token.** O token é a credencial de reset; registrá-lo no log o retém
 *    indexado e derrota o SHA-256 no banco. O log-fallback avisa que houve pedido e que
 *    nenhum canal real está configurado — não entrega o segredo.
 *  - Não lança: um canal de notificação indisponível não pode derrubar o fluxo de reset.
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { CanalDeNotificacao } from '../interfaces/notificacao.port.js';

/**
 * Cria o canal de log-fallback. Substituível pelo canal de e-mail da 019 sem tocar no
 * PasswordService — é a mesma porta.
 */
export function criarCanalDeLog(logger: Logger): CanalDeNotificacao {
  return {
    enviarReset(email: string): Promise<void> {
      logger.warn(
        { email, canal: 'log-fallback' },
        'password.reset.sem_canal_real — token gerado mas nenhum canal de entrega configurado (SPEC 019)',
      );
      return Promise.resolve();
    },
  };
}
