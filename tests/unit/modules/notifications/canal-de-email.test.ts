/**
 * Cobre o alerta ao operador — o concreto que faltava para a porta da SPEC 014.
 *
 * O que precisa ser verdade: o piso de severidade cala o ruído, a pista do sujeito não
 * atravessa para a caixa de entrada da equipe, e um transporte quebrado não derruba a
 * detecção.
 */
import { describe, expect, it } from 'vitest';
import { criarCanalDeEmail } from '../../../../src/modules/notifications/services/canal-de-email.js';
import { criarServicoDeNotificacao } from '../../../../src/modules/notifications/services/notification.service.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';
import type { EventoDeSeguranca } from '../../../../src/modules/security-events/types/security-event.js';
import type { Severidade } from '../../../../src/modules/security-events/constants/regras.js';
import type { MensagemDeEmail } from '../../../../src/modules/notifications/types/mensagem.js';
import type { TransportadorDeEmail } from '../../../../src/modules/notifications/interfaces/transporte.port.js';

const OPERACAO = ['seg@exemplo.com', 'plantao@exemplo.com'];
const PISTA = '9f2a1c3d4e5f60718293a4b5c6d7e8f900112233445566778899aabbccddeeff';

const EVENTO: EventoDeSeguranca = {
  id: '66b3f1c2a4e5d6f7a8b9c0d1',
  regra: 'brute_force_conta',
  severidade: 'alta',
  sujeito: { tipo: 'conta', pista: PISTA },
  ocorrencias: 12,
  janelaMs: 300_000,
  primeiraEm: new Date('2026-08-09T13:58:51.902Z'),
  ultimaEm: new Date('2026-08-09T14:03:51.902Z'),
  detectadoEm: new Date('2026-08-09T14:03:51.902Z'),
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  metadata: { tipo_de_evento: 'iam.auth.login_failed' },
};

function montar(
  severidadeMinima: Severidade = 'alta',
  transporte?: TransportadorDeEmail,
): {
  canal: ReturnType<typeof criarCanalDeEmail>;
  enviadas: MensagemDeEmail[];
  suprimidos: number;
} {
  const enviadas: MensagemDeEmail[] = [];
  const estado = { suprimidos: 0 };

  const canal = criarCanalDeEmail({
    notificacoes: criarServicoDeNotificacao({
      transporte: transporte ?? {
        enviar(mensagem) {
          enviadas.push(mensagem);
          return Promise.resolve({ ok: true as const });
        },
      },
      destinatarios: { emailDe: () => Promise.resolve(null) },
      teto: { incrementar: () => Promise.resolve(null), ler: () => Promise.resolve(null) },
      maxPorHora: 50,
      logger: criarLogger({ nivel: 'fatal' }),
    }),
    destinatarios: OPERACAO,
    severidadeMinima,
    aoSuprimir: () => {
      estado.suprimidos += 1;
    },
  });

  return {
    canal,
    enviadas,
    get suprimidos(): number {
      return estado.suprimidos;
    },
  };
}

describe('piso de severidade', () => {
  it('entrega o que está no piso', async () => {
    const m = montar('alta');

    await m.canal.alertar(EVENTO);

    expect(m.enviadas).toHaveLength(1);
    expect(m.enviadas[0]?.para).toEqual(OPERACAO);
  });

  it('cala o que está abaixo', async () => {
    const m = montar('alta');

    await m.canal.alertar({ ...EVENTO, severidade: 'media', regra: 'varredura_de_cliente' });

    // Caixa de entrada inundada é caixa de entrada ignorada.
    expect(m.enviadas).toHaveLength(0);
    expect(m.suprimidos).toBe(1);
  });

  it('piso mais baixo deixa passar mais', async () => {
    const m = montar('baixa');

    await m.canal.alertar({ ...EVENTO, severidade: 'media' });

    expect(m.enviadas).toHaveLength(1);
  });
});

describe('o que o alerta carrega', () => {
  it('o suficiente para agir', async () => {
    const m = montar();

    await m.canal.alertar(EVENTO);
    const mensagem = m.enviadas[0];

    expect(mensagem?.assunto).toBe('[IAM] Alerta de segurança: brute_force_conta');
    expect(mensagem?.texto).toContain('12 em 5 min');
    expect(mensagem?.texto).toContain(EVENTO.id);
    expect(mensagem?.texto).toContain(EVENTO.traceId);
  });

  it('nunca a pista do sujeito', async () => {
    const m = montar();

    await m.canal.alertar(EVENTO);
    const inteiro = JSON.stringify(m.enviadas[0]);

    // A pista é o que liga o alarme a uma pessoa; caixa de e-mail de equipe é o lugar
    // menos controlado onde esse vínculo poderia parar.
    expect(inteiro).not.toContain(PISTA);
  });
});

describe('robustez', () => {
  it('transporte quebrado não derruba a detecção', async () => {
    const m = montar('alta', { enviar: () => Promise.reject(new Error('provedor fora')) });

    await expect(m.canal.alertar(EVENTO)).resolves.toBeUndefined();
  });

  it('sem destinatários configurados, não lança', async () => {
    const canal = criarCanalDeEmail({
      notificacoes: criarServicoDeNotificacao({
        transporte: { enviar: () => Promise.resolve({ ok: true as const }) },
        destinatarios: { emailDe: () => Promise.resolve(null) },
        teto: { incrementar: () => Promise.resolve(null), ler: () => Promise.resolve(null) },
        maxPorHora: 50,
        logger: criarLogger({ nivel: 'fatal' }),
      }),
      destinatarios: [],
      severidadeMinima: 'baixa',
    });

    await expect(canal.alertar(EVENTO)).resolves.toBeUndefined();
  });
});
