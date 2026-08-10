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

/**
 * Digest do endereço, para correlacionar duas linhas sem guardar o endereço.
 *
 * **O pepper não é opcional.** E-mail é valor de entropia baixíssima: um `sha256` puro é
 * revertido com uma wordlist em segundos, e o digest sem segredo seria o endereço com passos
 * a mais. É a mesma razão pela qual a trilha da SPEC 013 derivou `subject_hint` com pepper.
 *
 * Curto de propósito: 64 bits bastam para ligar duas linhas de log e não bastam para montar
 * um índice reverso útil.
 */
export function criarDigestDeEndereco(pepper: string): (endereco: string) => string {
  return (endereco: string): string =>
    createHash('sha256')
      .update(`${endereco.trim().toLowerCase()}:${pepper}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
}

export function criarTransporteDeLog(logger: Logger, pepper: string): TransportadorDeEmail {
  const digestDeEndereco = criarDigestDeEndereco(pepper);

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
