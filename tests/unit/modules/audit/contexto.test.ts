/**
 * Cobre o enriquecimento do evento com o contexto da requisição.
 *
 * A propriedade que importa é a prioridade: o emissor descreve o que sabe e o contexto só
 * preenche o que faltou. Inverter isso faria um serviço administrativo, que age em nome de
 * outro ator, registrar quem clicou no lugar de quem foi afetado.
 */
import { describe, expect, it } from 'vitest';
import { enriquecerComContexto } from '../../../../src/modules/audit/services/contexto.js';
import { comContextoDeRequisicao } from '../../../../src/shared/context/request-context.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';

function evento(sobrescritas: Partial<EventoDeAuditoria> = {}): EventoDeAuditoria {
  return {
    type: 'iam.auth.login_failed',
    actor: { id: null, type: 'user' },
    outcome: 'failure',
    ...sobrescritas,
  };
}

describe('enriquecerComContexto', () => {
  it('preenche origem e ator a partir do contexto', () => {
    const enriquecido = comContextoDeRequisicao(
      { ip: '203.0.113.10', userAgent: 'curl/8.5.0', atorId: 'ator-do-token' },
      () => enriquecerComContexto(evento()),
    );

    expect(enriquecido.actor.ip).toBe('203.0.113.10');
    expect(enriquecido.actor.userAgent).toBe('curl/8.5.0');
    expect(enriquecido.actor.id).toBe('ator-do-token');
  });

  it('o que o emissor afirma vence o contexto', () => {
    const enriquecido = comContextoDeRequisicao({ ip: '10.0.0.1', atorId: 'quem-clicou' }, () =>
      enriquecerComContexto(
        evento({ actor: { id: 'quem-foi-afetado', type: 'user', ip: '203.0.113.10' } }),
      ),
    );

    expect(enriquecido.actor.id).toBe('quem-foi-afetado');
    expect(enriquecido.actor.ip).toBe('203.0.113.10');
  });

  it('fora de requisição o evento volta como veio', () => {
    const original = evento();

    expect(enriquecerComContexto(original)).toBe(original);
  });

  it('é idempotente — o decorador enriquece e o serviço enriquece de novo', () => {
    const uma = comContextoDeRequisicao({ ip: '203.0.113.10' }, () =>
      enriquecerComContexto(evento()),
    );
    const duas = comContextoDeRequisicao({ ip: '203.0.113.10' }, () => enriquecerComContexto(uma));

    expect(duas).toEqual(uma);
  });

  it('não inventa campo ausente', () => {
    const enriquecido = comContextoDeRequisicao({ ip: '203.0.113.10' }, () =>
      enriquecerComContexto(evento()),
    );

    // `exactOptionalPropertyTypes`: ausente é ausente, não `undefined` presente — um
    // `userAgent: undefined` viajaria até o Mongo como chave gravada.
    expect('userAgent' in enriquecido.actor).toBe(false);
  });
});
