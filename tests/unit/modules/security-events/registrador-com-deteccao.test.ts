/**
 * Cobre o decorador que liga a detecção à porta de auditoria.
 *
 * O caso que motivou este arquivo: o detector recebia o evento **cru**, e nenhum emissor
 * preenche `actor.ip` — quem o conhece é o contexto da requisição, lido só na hora de
 * persistir. A regra que correlaciona por origem via `undefined` e nunca fechava limiar.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarRegistradorComDeteccao } from '../../../../src/modules/security-events/services/registrador-com-deteccao.js';
import { comContextoDeRequisicao } from '../../../../src/shared/context/request-context.js';
import type { Detector } from '../../../../src/modules/security-events/services/detector.service.js';
import type { RegistradorDeAuditoria } from '../../../../src/modules/audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';

const EVENTO: EventoDeAuditoria = {
  type: 'iam.auth.login_failed',
  actor: { id: null, type: 'user' },
  outcome: 'failure',
};

function montar(sobrescritas: { base?: RegistradorDeAuditoria; detector?: Detector } = {}): {
  registrador: RegistradorDeAuditoria;
  observados: EventoDeAuditoria[];
  registrados: EventoDeAuditoria[];
} {
  const observados: EventoDeAuditoria[] = [];
  const registrados: EventoDeAuditoria[] = [];

  const base: RegistradorDeAuditoria = sobrescritas.base ?? {
    registrar(evento): Promise<void> {
      registrados.push(evento);
      return Promise.resolve();
    },
  };
  const detector: Detector = sobrescritas.detector ?? {
    observar(evento): Promise<void> {
      observados.push(evento);
      return Promise.resolve();
    },
  };

  return { registrador: criarRegistradorComDeteccao(base, detector), observados, registrados };
}

describe('criarRegistradorComDeteccao', () => {
  it('o detector recebe a origem da requisição, não o evento cru', async () => {
    const { registrador, observados } = montar();

    await comContextoDeRequisicao({ ip: '203.0.113.10', userAgent: 'curl/8.5.0' }, () =>
      registrador.registrar(EVENTO),
    );

    expect(observados[0]?.actor.ip).toBe('203.0.113.10');
    expect(observados[0]?.actor.userAgent).toBe('curl/8.5.0');
  });

  it('a trilha e o detector veem o mesmo evento', async () => {
    const { registrador, observados, registrados } = montar();

    await comContextoDeRequisicao({ ip: '203.0.113.10' }, () => registrador.registrar(EVENTO));

    expect(observados[0]).toEqual(registrados[0]);
  });

  it('não aguarda a detecção', async () => {
    let concluiu = false;
    const detector: Detector = {
      async observar(): Promise<void> {
        await new Promise((resolver) => setTimeout(resolver, 30));
        concluiu = true;
      },
    };

    await montar({ detector }).registrador.registrar(EVENTO);

    // O fato é aguardado; o juízo não. Se este `false` virar `true`, a detecção entrou no
    // caminho crítico do login e o custo aparece no p95 de quem só quer entrar.
    expect(concluiu).toBe(false);
  });

  it('detecção que explode não derruba o registro', async () => {
    const detector: Detector = { observar: () => Promise.reject(new Error('regra quebrada')) };

    await expect(montar({ detector }).registrador.registrar(EVENTO)).resolves.toBeUndefined();
  });

  it('falha da trilha continua propagando pelo caminho de sempre', async () => {
    // O registrador base é quem decide engolir — o decorador não pode mascarar o que ele fez.
    const base: RegistradorDeAuditoria = { registrar: () => Promise.reject(new Error('mongo')) };
    const observar = vi.fn(() => Promise.resolve());

    await expect(
      montar({ base, detector: { observar } }).registrador.registrar(EVENTO),
    ).rejects.toThrow('mongo');
    expect(observar).not.toHaveBeenCalled();
  });
});
