/**
 * Responsabilidade: transporte que não manda nada para a rede — o de desenvolvimento, de
 * teste e de todo ambiente que subiu sem provedor configurado.
 * Regras:
 *  - **Registra digest, nunca o endereço.** É o mesmo endereço que o RF proíbe em log,
 *    métrica e span; um transporte de mentira não é licença para vazá-lo.
 *  - **Não registra o corpo.** O corpo do reset carrega o token, e o do aviso carrega a
 *    origem do acesso do usuário. O que interessa em desenvolvimento é que a mensagem saiu,
 *    para quantos e de que tipo.
 *  - Devolve sucesso: em desenvolvimento, "não entregou" seria um falso incidente em toda
 *    execução da suíte.
 */
import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger/index.js';
import type { TransportadorDeEmail, ResultadoDeEntrega } from '../interfaces/transporte.port.js';
import type { MensagemDeEmail } from '../types/mensagem.js';

/** Digest curto: o suficiente para correlacionar duas linhas, insuficiente para reverter. */
export function digestDeEndereco(endereco: string): string {
  return createHash('sha256')
    .update(endereco.trim().toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function criarTransporteDeLog(logger: Logger): TransportadorDeEmail {
  return {
    enviar(mensagem: MensagemDeEmail): Promise<ResultadoDeEntrega> {
      logger.info(
        {
          evento: 'notification.entregue',
          destinatarios: mensagem.para.map(digestDeEndereco),
          canal: 'log-fallback',
        },
        'notification.sem_transporte_real — mensagem não saiu para a rede',
      );
      return Promise.resolve({ ok: true });
    },
  };
}
