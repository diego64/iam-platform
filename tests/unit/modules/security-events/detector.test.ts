/**
 * Cobre as regras, o detector e o decorador.
 *
 * Os três casos que este arquivo existe para travar: uma regra que quebra não cega as
 * outras, o silêncio não deixa o alarme virar fluxo, e a trilha é registrada mesmo quando a
 * detecção explode.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  bruteForceConta,
  credentialStuffing,
  mfaSobAtaque,
  reusoDeRefresh,
  varreduraDeCliente,
  type ContextoDeRegra,
} from '../../../../src/modules/security-events/services/regras/index.js';
import { criarDetector } from '../../../../src/modules/security-events/services/detector.service.js';
import { criarRegistradorComDeteccao } from '../../../../src/modules/security-events/services/registrador-com-deteccao.js';
import { criarExtratorDeSujeito } from '../../../../src/modules/security-events/services/sujeito.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';
import type { EventoDeSeguranca } from '../../../../src/modules/security-events/types/security-event.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const EMAIL = 'vitima@iam.local';

const LIMIARES = {
  bruteForceMax: 3,
  bruteForceJanelaMs: 300_000,
  stuffingContasMax: 3,
  stuffingJanelaMs: 600_000,
  varreduraDeClienteMax: 3,
  varreduraDeClienteJanelaMs: 300_000,
  mfaFalhasMax: 3,
  mfaJanelaMs: 600_000,
};

function contexto(
  opcoes: { contagem?: number | null; distintas?: number | null } = {},
): ContextoDeRegra {
  const estado =
    opcoes.contagem === null || opcoes.contagem === undefined
      ? opcoes.contagem === null
        ? null
        : { contagem: 1, expiraEm: new Date() }
      : { contagem: opcoes.contagem, expiraEm: new Date() };

  return {
    contador: {
      incrementar: () => Promise.resolve(estado),
      ler: () => Promise.resolve(estado),
    },
    conjuntos: {
      registrar: () => Promise.resolve(opcoes.distintas ?? 1),
    },
    extrator: criarExtratorDeSujeito(PEPPER),
    limiares: LIMIARES,
  };
}

function evento(sobrescritas: Partial<EventoDeAuditoria> = {}): EventoDeAuditoria {
  return {
    type: 'iam.auth.login_failed',
    actor: { id: null, type: 'user', ip: '10.0.0.1' },
    outcome: 'failure',
    subjectEmail: EMAIL,
    ...sobrescritas,
  };
}

/** Evento sem o e-mail do sujeito — o campo é omitido, não posto como `undefined`. */
function eventoSemConta(sobrescritas: Partial<EventoDeAuditoria> = {}): EventoDeAuditoria {
  const completo: Record<string, unknown> = { ...evento(sobrescritas) };
  delete completo.subjectEmail;
  return completo as unknown as EventoDeAuditoria;
}

describe('brute_force_conta', () => {
  it('dispara no limiar', async () => {
    const deteccao = await bruteForceConta(evento(), contexto({ contagem: 3 }));

    expect(deteccao).toMatchObject({
      regra: 'brute_force_conta',
      severidade: 'alta',
      ocorrencias: 3,
    });
  });

  it('não dispara abaixo do limiar', async () => {
    await expect(bruteForceConta(evento(), contexto({ contagem: 2 }))).resolves.toBeNull();
  });

  it('ignora evento de outro tipo', async () => {
    const outro = evento({ type: 'iam.auth.login' });

    await expect(bruteForceConta(outro, contexto({ contagem: 99 }))).resolves.toBeNull();
  });

  it('contador indisponível não vira alarme falso', async () => {
    await expect(bruteForceConta(evento(), contexto({ contagem: null }))).resolves.toBeNull();
  });

  it('o sujeito é a pista, nunca o e-mail', async () => {
    const deteccao = await bruteForceConta(evento(), contexto({ contagem: 3 }));

    expect(JSON.stringify(deteccao)).not.toContain(EMAIL);
    expect(deteccao?.sujeito.pista).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('credential_stuffing', () => {
  it('dispara com contas distintas no limiar', async () => {
    const deteccao = await credentialStuffing(evento(), contexto({ distintas: 3 }));

    expect(deteccao).toMatchObject({ regra: 'credential_stuffing', ocorrencias: 3 });
    expect(deteccao?.sujeito.tipo).toBe('ip');
  });

  it('sem IP não há o que correlacionar', async () => {
    const semIp = evento({ actor: { id: null, type: 'user' } });

    await expect(credentialStuffing(semIp, contexto({ distintas: 99 }))).resolves.toBeNull();
  });

  it('sem conta também não: a pergunta é quantas contas distintas', async () => {
    const semConta = eventoSemConta();

    await expect(credentialStuffing(semConta, contexto({ distintas: 99 }))).resolves.toBeNull();
  });
});

describe('varredura_de_cliente', () => {
  function recusa(erro: string): EventoDeAuditoria {
    return evento({
      type: 'iam.oauth.token_denied',
      actor: { id: 'cli_abc', type: 'client' },
      metadata: { erro },
    });
  }

  it('dispara com invalid_client no limiar', async () => {
    const deteccao = await varreduraDeCliente(recusa('invalid_client'), contexto({ contagem: 3 }));

    expect(deteccao).toMatchObject({ regra: 'varredura_de_cliente', severidade: 'media' });
  });

  it('outros erros de OAuth não contam', async () => {
    // Escopo inválido e grant não autorizado são erro de integração, não ataque.
    for (const erro of ['invalid_scope', 'unauthorized_client', 'unsupported_grant_type']) {
      await expect(
        varreduraDeCliente(recusa(erro), contexto({ contagem: 99 })),
      ).resolves.toBeNull();
    }
  });
});

describe('reuso_de_refresh', () => {
  it('dispara na primeira ocorrência, sem contador', async () => {
    // Exigir estatística aqui seria esperar o segundo roubo para avisar do primeiro.
    const semContador = contexto({ contagem: null });
    const reuso = eventoSemConta({
      type: 'iam.token.reuse_detected',
      actor: { id: 'u1', type: 'user' },
    });

    const deteccao = await reusoDeRefresh(reuso, semContador);

    expect(deteccao).toMatchObject({ regra: 'reuso_de_refresh', ocorrencias: 1, janelaMs: 0 });
  });
});

describe('mfa_sob_ataque', () => {
  it('dispara por ator no limiar', async () => {
    const falha = evento({ type: 'iam.mfa.failed', actor: { id: 'u1', type: 'user' } });

    const deteccao = await mfaSobAtaque(falha, contexto({ contagem: 3 }));

    expect(deteccao).toMatchObject({ regra: 'mfa_sob_ataque' });
    expect(deteccao?.sujeito.tipo).toBe('usuario');
  });

  it('sem ator identificável não há sujeito', async () => {
    const anonima = evento({ type: 'iam.mfa.failed' });

    await expect(mfaSobAtaque(anonima, contexto({ contagem: 99 }))).resolves.toBeNull();
  });
});

interface FakesDoDetector {
  detector: ReturnType<typeof criarDetector>;
  anexar: ReturnType<typeof vi.fn>;
  alertar: ReturnType<typeof vi.fn>;
  incrementarSilencio: ReturnType<typeof vi.fn>;
  medidor: { contarEvento: ReturnType<typeof vi.fn>; contarErro: ReturnType<typeof vi.fn> };
}

type RegrasDoDetector = NonNullable<Parameters<typeof criarDetector>[0]['regras']>;

function montarDetector(
  opcoes: { silenciado?: boolean; regras?: RegrasDoDetector } = {},
): FakesDoDetector {
  const anexar = vi.fn((entrada: { regra: string }) =>
    Promise.resolve({ ...entrada, id: 'evt-1' } as unknown as EventoDeSeguranca),
  );
  const alertar = vi.fn(() => Promise.resolve());
  const incrementarSilencio = vi.fn(() => Promise.resolve({ contagem: 1, expiraEm: new Date() }));
  const medidor = {
    contarEvento: vi.fn(),
    contarErro: vi.fn(),
    observarDeteccao: vi.fn(),
  };

  const detector = criarDetector({
    contexto: contexto({ contagem: 3 }),
    eventos: {
      anexar,
      listar: () => Promise.resolve({ itens: [], proximoCursor: null }),
      buscarPorId: () => Promise.resolve(null),
    },
    silencio: {
      ler: () =>
        Promise.resolve({ contagem: opcoes.silenciado === true ? 1 : 0, expiraEm: new Date() }),
      incrementar: incrementarSilencio,
    },
    silencioMs: 900_000,
    retencaoMs: 1_000,
    canal: { alertar },
    medidor,
    ...(opcoes.regras === undefined ? {} : { regras: opcoes.regras }),
  });

  return { detector, anexar, alertar, incrementarSilencio, medidor };
}

describe('detector', () => {
  it('persiste, mede, alerta e silencia — nessa ordem', async () => {
    const { detector, anexar, alertar, incrementarSilencio, medidor } = montarDetector();

    await detector.observar(evento());

    expect(anexar).toHaveBeenCalled();
    expect(medidor.contarEvento).toHaveBeenCalledWith('brute_force_conta', 'alta');
    expect(alertar).toHaveBeenCalledOnce();
    expect(incrementarSilencio).toHaveBeenCalled();
  });

  it('dentro do silêncio não dispara de novo', async () => {
    const { detector, anexar, alertar } = montarDetector({ silenciado: true });

    await detector.observar(evento());

    expect(anexar).not.toHaveBeenCalled();
    expect(alertar).not.toHaveBeenCalled();
  });

  it('uma regra que lança não impede as outras', async () => {
    // Sem isso, um erro numa regra apagaria a detecção inteira em silêncio.
    const quebrada = (): Promise<never> => Promise.reject(new Error('regra quebrada'));
    const { detector, anexar, medidor } = montarDetector({
      regras: [quebrada, bruteForceConta],
    });

    await detector.observar(evento());

    expect(medidor.contarErro).toHaveBeenCalledOnce();
    expect(anexar).toHaveBeenCalledOnce();
  });

  it('observar nunca rejeita, mesmo com tudo quebrado', async () => {
    const quebrada = (): Promise<never> => Promise.reject(new Error('x'));
    const { detector } = montarDetector({ regras: [quebrada, quebrada] });

    await expect(detector.observar(evento())).resolves.toBeUndefined();
  });

  it('canal que lança não impede o evento de ser persistido', async () => {
    const { detector, anexar, alertar } = montarDetector();
    alertar.mockRejectedValueOnce(new Error('canal fora'));

    await detector.observar(evento());

    expect(anexar).toHaveBeenCalledOnce();
  });
});

describe('decorador da porta de auditoria', () => {
  it('a trilha é chamada mesmo quando a detecção lança', async () => {
    const registrarNaTrilha = vi.fn(() => Promise.resolve());
    const registrador = criarRegistradorComDeteccao(
      { registrar: registrarNaTrilha },
      { observar: () => Promise.reject(new Error('detector fora')) },
    );

    await expect(registrador.registrar(evento())).resolves.toBeUndefined();
    expect(registrarNaTrilha).toHaveBeenCalledOnce();
  });

  it('o retorno não espera a detecção terminar', async () => {
    // A requisição que gerou o fato não pode pagar pela correlação.
    let detectou = false;
    const registrador = criarRegistradorComDeteccao(
      { registrar: () => Promise.resolve() },
      {
        observar: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          detectou = true;
        },
      },
    );

    await registrador.registrar(evento());

    expect(detectou).toBe(false);
  });

  it('a trilha é aguardada — o fato não pode ficar para trás', async () => {
    let gravou = false;
    const registrador = criarRegistradorComDeteccao(
      {
        registrar: async () => {
          await Promise.resolve();
          gravou = true;
        },
      },
      { observar: () => Promise.resolve() },
    );

    await registrador.registrar(evento());

    expect(gravou).toBe(true);
  });
});
