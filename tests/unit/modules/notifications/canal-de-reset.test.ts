/**
 * Cobre a entrega do token de reset — o concreto que faltava para a porta da SPEC 009.
 *
 * O token é a credencial: ele pode estar no link e em lugar nenhum mais.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { criarCanalDeReset } from '../../../../src/modules/notifications/services/canal-de-reset.js';
import { criarServicoDeNotificacao } from '../../../../src/modules/notifications/services/notification.service.js';
import { criarTransporteDeLog } from '../../../../src/modules/notifications/services/transporte-de-log.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';
import type { MensagemDeEmail } from '../../../../src/modules/notifications/types/mensagem.js';
import type { TransportadorDeEmail } from '../../../../src/modules/notifications/interfaces/transporte.port.js';

const EMAIL = 'user@iam.local';
const TOKEN = 'token-secreto-de-reset';
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const URL_RESET = 'https://conta.exemplo.com/redefinir';

function montar(transporte: TransportadorDeEmail): ReturnType<typeof criarCanalDeReset> {
  return criarCanalDeReset({
    notificacoes: criarServicoDeNotificacao({
      transporte,
      destinatarios: { emailDe: () => Promise.resolve(null) },
      teto: { incrementar: () => Promise.resolve(null), ler: () => Promise.resolve(null) },
      maxPorHora: 5,
      pepper: PEPPER,
      logger: criarLogger({ nivel: 'fatal' }),
    }),
    urlDeReset: URL_RESET,
    validadeMin: 30,
  });
}

describe('criarCanalDeReset', () => {
  it('entrega o token no link, para o endereço que pediu', async () => {
    const enviadas: MensagemDeEmail[] = [];
    const transporte: TransportadorDeEmail = {
      enviar(mensagem) {
        enviadas.push(mensagem);
        return Promise.resolve({ ok: true as const });
      },
    };

    await montar(transporte).enviarReset(EMAIL, TOKEN);

    expect(enviadas[0]?.para).toEqual([EMAIL]);
    expect(enviadas[0]?.texto).toContain(`${URL_RESET}?token=${TOKEN}`);
    expect(enviadas[0]?.assunto).toBe('Redefinição de senha');
  });

  it('o token não passa pelo log', async () => {
    const linhas: string[] = [];
    const destino = new Writable({
      write(pedaco: Buffer, _codificacao, prosseguir): void {
        linhas.push(pedaco.toString());
        prosseguir();
      },
    });
    const logger = criarLogger({ nivel: 'trace', destino });

    const canal = criarCanalDeReset({
      notificacoes: criarServicoDeNotificacao({
        transporte: criarTransporteDeLog(logger, PEPPER),
        destinatarios: { emailDe: () => Promise.resolve(null) },
        teto: { incrementar: () => Promise.resolve(null), ler: () => Promise.resolve(null) },
        pepper: PEPPER,
        maxPorHora: 5,
        logger,
      }),
      urlDeReset: URL_RESET,
      validadeMin: 30,
    });

    await canal.enviarReset(EMAIL, TOKEN);
    const saida = linhas.join('');

    expect(saida).not.toContain(TOKEN);
    expect(saida).not.toContain(EMAIL);
  });

  it('não lança quando o transporte falha — o reset já gravou o token', async () => {
    const transporte: TransportadorDeEmail = {
      enviar: () => Promise.reject(new Error('provedor fora')),
    };

    await expect(montar(transporte).enviarReset(EMAIL, TOKEN)).resolves.toBeUndefined();
  });
});
