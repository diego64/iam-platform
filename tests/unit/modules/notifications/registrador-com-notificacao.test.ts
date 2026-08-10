/**
 * Cobre o decorador que transforma fato auditado em aviso.
 *
 * O que precisa ser verdade: só os fatos da tabela avisam, quem recebe é o afetado (e não
 * o administrador que agiu), o login só avisa em dispositivo novo, e nada disso entra no
 * caminho da requisição.
 */
import { describe, expect, it } from 'vitest';
import {
  criarNotificador,
  criarRegistradorComNotificacao,
} from '../../../../src/modules/notifications/services/registrador-com-notificacao.js';
import { comContextoDeRequisicao } from '../../../../src/shared/context/request-context.js';
import type { ServicoDeNotificacao } from '../../../../src/modules/notifications/services/notification.service.js';
import type { RepositorioDeDispositivos } from '../../../../src/modules/notifications/repositories/known-device.repository.js';
import type { MedidorDeNotificacoes } from '../../../../src/modules/notifications/metrics/notifications.metrics.js';
import type { RegistradorDeAuditoria } from '../../../../src/modules/audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

interface Avisado {
  userId: string;
  tipo: string;
  assunto: string;
  texto: string;
}

function montar(dispositivoNovo = true): {
  observar(evento: EventoDeAuditoria): Promise<void>;
  avisados: Avisado[];
  vistos: { userId: string; ip: string | null; userAgent: string | null }[];
  supressoes: { tipo: string; motivo: string }[];
} {
  const avisados: Avisado[] = [];
  const vistos: { userId: string; ip: string | null; userAgent: string | null }[] = [];
  const supressoes: { tipo: string; motivo: string }[] = [];

  const notificacoes = {
    notificarUsuario(userId: string, tipo: string, corpo: { assunto: string; texto: string }) {
      avisados.push({ userId, tipo, assunto: corpo.assunto, texto: corpo.texto });
      return Promise.resolve({ ok: true as const });
    },
    enviar: () => Promise.resolve({ ok: true as const }),
  } as unknown as ServicoDeNotificacao;

  const dispositivos: RepositorioDeDispositivos = {
    ehNovo(dispositivo): Promise<boolean> {
      vistos.push(dispositivo);
      return Promise.resolve(dispositivoNovo);
    },
  };

  const medidor = {
    contarEnvio: () => undefined,
    contarFalha: () => undefined,
    contarSupressao: (tipo: string, motivo: string) => {
      supressoes.push({ tipo, motivo });
    },
    observarEntrega: () => undefined,
  } as unknown as MedidorDeNotificacoes;

  return {
    ...criarNotificador({ notificacoes, dispositivos, medidor }),
    avisados,
    vistos,
    supressoes,
  };
}

const LOGIN: EventoDeAuditoria = {
  type: 'iam.auth.login',
  actor: { id: USUARIO, type: 'user', ip: '203.0.113.10', userAgent: 'Mozilla/5.0' },
  outcome: 'success',
};

describe('quais fatos viram aviso', () => {
  it('login de dispositivo novo avisa', async () => {
    const m = montar();

    await m.observar(LOGIN);

    expect(m.avisados).toHaveLength(1);
    expect(m.avisados[0]?.tipo).toBe('login_novo');
    expect(m.avisados[0]?.userId).toBe(USUARIO);
    expect(m.avisados[0]?.texto).toContain('203.0.113.10');
  });

  it('login de dispositivo conhecido não avisa, mas conta o silêncio', async () => {
    const m = montar(false);

    await m.observar(LOGIN);

    expect(m.avisados).toHaveLength(0);
    // É o silêncio mais frequente do sistema: sem contador, "não recebi o aviso de login"
    // é indistinguível de um canal quebrado.
    expect(m.supressoes).toEqual([{ tipo: 'login_novo', motivo: 'dispositivo_conhecido' }]);
  });

  it('login com segundo fator avisa — é a conta mais protegida da plataforma', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.mfa.verified',
      actor: { id: USUARIO, type: 'user', ip: '203.0.113.10', userAgent: 'Mozilla/5.0' },
      outcome: 'success',
    });

    // Quem tem MFA não passa por `iam.auth.login`: o login para no desafio e quem registra a
    // entrada é este evento. Sem ele no mapa, justamente essa conta nunca era avisada.
    expect(m.avisados).toHaveLength(1);
    expect(m.avisados[0]?.tipo).toBe('login_novo');
  });

  it('código de recuperação avisa mesmo de dispositivo conhecido', async () => {
    const m = montar(false);

    await m.observar({
      type: 'iam.mfa.recovery_used',
      actor: { id: USUARIO, type: 'user', ip: '203.0.113.10', userAgent: 'Mozilla/5.0' },
      outcome: 'success',
    });

    // O que chama atenção é o contorno do segundo fator, não a origem de onde ele veio.
    expect(m.avisados[0]?.tipo).toBe('recuperacao_usada');
    expect(m.avisados[0]?.assunto).toContain('código de recuperação');
    expect(m.vistos).toHaveLength(0);
  });

  it('troca e reset de senha avisam a mesma coisa', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.password.changed',
      actor: { id: USUARIO, type: 'user' },
      outcome: 'success',
    });
    await m.observar({
      type: 'iam.password.reset_completed',
      actor: { id: USUARIO, type: 'user' },
      outcome: 'success',
    });

    expect(m.avisados.map((a) => a.tipo)).toEqual(['senha_alterada', 'senha_alterada']);
  });

  it('os três eventos de MFA avisam', async () => {
    const m = montar();

    for (const type of ['iam.mfa.enrolled', 'iam.mfa.disabled'] as const) {
      await m.observar({ type, actor: { id: USUARIO, type: 'user' }, outcome: 'success' });
    }

    expect(m.avisados.map((a) => a.tipo)).toEqual(['mfa_alterado', 'mfa_alterado']);
  });

  it('login falho não avisa — isso é assunto do detector', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.auth.login_failed',
      actor: { id: USUARIO, type: 'user' },
      outcome: 'failure',
      subjectEmail: 'vitima@iam.local',
    });

    // Um aviso por tentativa daria a quem ataca um botão de incomodar a vítima à vontade.
    expect(m.avisados).toHaveLength(0);
  });

  it('fato fora da tabela não avisa', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.role.assigned',
      actor: { id: ADMIN, type: 'user' },
      target: { id: USUARIO, type: 'user' },
      outcome: 'success',
    });

    expect(m.avisados).toHaveLength(0);
  });

  it('desfecho de falha não avisa nem para os tipos da tabela', async () => {
    const m = montar();

    await m.observar({ ...LOGIN, outcome: 'failure' });

    expect(m.avisados).toHaveLength(0);
  });
});

describe('quem recebe', () => {
  it('bloqueio de conta avisa o bloqueado, não o administrador', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.user.blocked',
      actor: { id: ADMIN, type: 'user' },
      target: { id: USUARIO, type: 'user' },
      outcome: 'success',
      reason: 'admin_action',
    });

    expect(m.avisados[0]?.userId).toBe(USUARIO);
    expect(m.avisados[0]?.tipo).toBe('conta_bloqueada');
  });

  it('reset de MFA por administrador avisa o dono do fator', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.mfa.reset',
      actor: { id: ADMIN, type: 'user' },
      target: { id: USUARIO, type: 'user' },
      outcome: 'success',
      reason: 'admin_action',
    });

    expect(m.avisados[0]?.userId).toBe(USUARIO);
  });

  it('sem ator e sem alvo identificáveis, ninguém é avisado', async () => {
    const m = montar();

    await m.observar({
      type: 'iam.auth.login',
      actor: { id: null, type: 'user' },
      outcome: 'success',
    });

    expect(m.avisados).toHaveLength(0);
  });
});

describe('o dispositivo consultado', () => {
  it('leva a origem que veio no evento', async () => {
    const m = montar();

    await m.observar(LOGIN);

    expect(m.vistos[0]).toEqual({
      userId: USUARIO,
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
    });
  });
});

describe('o decorador', () => {
  function pilha(atraso = 0): {
    registrador: RegistradorDeAuditoria;
    estado: { concluiu: boolean; registrados: number };
  } {
    const estado = { concluiu: false, registrados: 0 };
    const base: RegistradorDeAuditoria = {
      registrar(): Promise<void> {
        estado.registrados += 1;
        return Promise.resolve();
      },
    };
    const notificador = {
      async observar(): Promise<void> {
        await new Promise((resolver) => setTimeout(resolver, atraso));
        estado.concluiu = true;
      },
    };

    return { registrador: criarRegistradorComNotificacao(base, notificador), estado };
  }

  it('não aguarda o aviso', async () => {
    const { registrador, estado } = pilha(30);

    await registrador.registrar(LOGIN);

    expect(estado.registrados).toBe(1);
    expect(estado.concluiu).toBe(false);
  });

  it('aviso que explode não derruba o registro', async () => {
    const base: RegistradorDeAuditoria = { registrar: () => Promise.resolve() };
    const notificador = { observar: () => Promise.reject(new Error('provedor fora')) };

    await expect(
      criarRegistradorComNotificacao(base, notificador).registrar(LOGIN),
    ).resolves.toBeUndefined();
  });

  it('entrega ao notificador a origem da requisição', async () => {
    const recebidos: EventoDeAuditoria[] = [];
    const base: RegistradorDeAuditoria = { registrar: () => Promise.resolve() };
    const notificador = {
      observar(evento: EventoDeAuditoria): Promise<void> {
        recebidos.push(evento);
        return Promise.resolve();
      },
    };
    const registrador = criarRegistradorComNotificacao(base, notificador);

    await comContextoDeRequisicao({ ip: '198.51.100.7', userAgent: 'curl/8.5.0' }, () =>
      registrador.registrar({
        type: 'iam.auth.login',
        actor: { id: USUARIO, type: 'user' },
        outcome: 'success',
      }),
    );

    // Sem isto, todo login pareceria vir de "origem não identificada" e o dispositivo
    // seria sempre o mesmo balde.
    expect(recebidos[0]?.actor.ip).toBe('198.51.100.7');
  });
});
