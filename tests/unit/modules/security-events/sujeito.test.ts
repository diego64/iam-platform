/**
 * Cobre a extração de sujeito.
 *
 * O caso que importa é a paridade com a trilha: se a pista daqui não bater com o
 * `subject_hint` que o serviço de auditoria grava, um evento de segurança vira um beco sem
 * saída — ninguém consegue descobrir de quem se trata.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { criarExtratorDeSujeito } from '../../../../src/modules/security-events/services/sujeito.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const EMAIL = 'vitima@iam.local';

const extrator = criarExtratorDeSujeito(PEPPER);

function evento(sobrescritas: Partial<EventoDeAuditoria> = {}): EventoDeAuditoria {
  return {
    type: 'iam.auth.login_failed',
    actor: { id: null, type: 'user' },
    outcome: 'failure',
    ...sobrescritas,
  };
}

/** A fórmula do `derivarPista` do serviço de auditoria, copiada aqui de propósito. */
function pistaDaTrilha(valor: string): string {
  return createHash('sha256')
    .update(`${valor.trim().toLowerCase()}:${PEPPER}`, 'utf8')
    .digest('hex');
}

describe('daConta', () => {
  it('a pista bate com a que a trilha grava', () => {
    // Sem esta igualdade, cruzar evento de segurança com trilha é impossível.
    const sujeito = extrator.daConta(evento({ subjectEmail: EMAIL }));

    expect(sujeito?.pista).toBe(pistaDaTrilha(EMAIL));
    expect(sujeito?.tipo).toBe('conta');
  });

  it('normaliza caixa e espaço, como a trilha', () => {
    expect(extrator.daConta(evento({ subjectEmail: '  VITIMA@iam.local ' }))?.pista).toBe(
      extrator.daConta(evento({ subjectEmail: EMAIL }))?.pista,
    );
  });

  it('o e-mail não sobrevive na saída', () => {
    const sujeito = extrator.daConta(evento({ subjectEmail: EMAIL }));

    expect(JSON.stringify(sujeito)).not.toContain('vitima');
    expect(JSON.stringify(sujeito)).not.toContain('iam.local');
  });

  it('evento sem e-mail não vira sujeito', () => {
    expect(extrator.daConta(evento())).toBeNull();
    expect(extrator.daConta(evento({ subjectEmail: '   ' }))).toBeNull();
  });
});

describe('doIp', () => {
  it('deriva a pista do endereço', () => {
    const sujeito = extrator.doIp(evento({ actor: { id: null, type: 'user', ip: '10.0.0.7' } }));

    expect(sujeito).toEqual({ tipo: 'ip', pista: pistaDaTrilha('10.0.0.7') });
  });

  it('o endereço não sobrevive na saída', () => {
    const sujeito = extrator.doIp(evento({ actor: { id: null, type: 'user', ip: '10.0.0.7' } }));

    expect(JSON.stringify(sujeito)).not.toContain('10.0.0.7');
  });

  it('evento sem IP não vira sujeito', () => {
    expect(extrator.doIp(evento())).toBeNull();
  });
});

describe('doAtor', () => {
  it('cliente vira sujeito do tipo cliente', () => {
    const sujeito = extrator.doAtor(
      evento({ type: 'iam.oauth.token_denied', actor: { id: 'cli_abc', type: 'client' } }),
    );

    expect(sujeito?.tipo).toBe('cliente');
    expect(sujeito?.pista).toBe(pistaDaTrilha('cli_abc'));
  });

  it('usuário autenticado vira sujeito do tipo usuario', () => {
    const sujeito = extrator.doAtor(evento({ actor: { id: 'u1', type: 'user' } }));

    expect(sujeito?.tipo).toBe('usuario');
  });

  it('evento sem ator identificável não vira sujeito', () => {
    // É o caso do login falho: o ator é nulo justamente para não dizer se a conta existe.
    expect(extrator.doAtor(evento())).toBeNull();
  });
});

describe('separação entre dimensões', () => {
  it('o mesmo valor em dimensões diferentes produz a mesma pista, e o tipo é que separa', () => {
    // A pista é o digest do valor; o que impede a mistura é a chave do contador, que leva a
    // regra junto — e cada regra usa uma dimensão só.
    const comoIp = extrator.doIp(evento({ actor: { id: null, type: 'user', ip: 'x' } }));
    const comoAtor = extrator.doAtor(evento({ actor: { id: 'x', type: 'user' } }));

    expect(comoIp?.pista).toBe(comoAtor?.pista);
    expect(comoIp?.tipo).not.toBe(comoAtor?.tipo);
  });
});
