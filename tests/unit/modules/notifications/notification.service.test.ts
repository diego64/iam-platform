/**
 * Cobre a decisão de enviar.
 *
 * Três silêncios diferentes precisam ser distinguíveis: não havia destinatário, o teto da
 * hora estourou, e o transporte falhou. Sem essa distinção, "não recebi o e-mail" não tem
 * diagnóstico — e os três pedem ações diferentes.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarServicoDeNotificacao } from '../../../../src/modules/notifications/services/notification.service.js';
import type { ServicoDeNotificacao } from '../../../../src/modules/notifications/services/notification.service.js';
import type { MedidorDeNotificacoes } from '../../../../src/modules/notifications/metrics/notifications.metrics.js';
import type {
  ResultadoDeEntrega,
  TransportadorDeEmail,
} from '../../../../src/modules/notifications/interfaces/transporte.port.js';
import type { MensagemDeEmail } from '../../../../src/modules/notifications/types/mensagem.js';
import type { ContadorDeRateLimit } from '../../../../src/shared/rate-limit/types.js';
import type { Logger } from '../../../../src/shared/logger/index.js';

const CORPO = { assunto: 'Sua senha foi alterada', texto: 'corpo', html: '<p>corpo</p>' };
const USUARIO = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'vitima@iam.local';

interface Montagem {
  servico: ServicoDeNotificacao;
  enviadas: MensagemDeEmail[];
  supressoes: { tipo: string; motivo: string }[];
  envios: { tipo: string; resultado: string }[];
  falhas: number;
  linhas: Record<string, unknown>[];
}

function montar(
  opcoes: {
    entrega?: ResultadoDeEntrega;
    email?: string | null;
    contagem?: number | null;
    maxPorHora?: number;
  } = {},
): Montagem {
  const enviadas: MensagemDeEmail[] = [];
  const supressoes: { tipo: string; motivo: string }[] = [];
  const envios: { tipo: string; resultado: string }[] = [];
  const linhas: Record<string, unknown>[] = [];
  const estado = { falhas: 0 };

  const transporte: TransportadorDeEmail = {
    enviar(mensagem): Promise<ResultadoDeEntrega> {
      enviadas.push(mensagem);
      return Promise.resolve(opcoes.entrega ?? { ok: true });
    },
  };

  // `null` explícito é "contador fora do ar"; ausente é a contagem normal de 1.
  const contagem = opcoes.contagem === undefined ? 1 : opcoes.contagem;
  const teto: ContadorDeRateLimit = {
    incrementar: () =>
      Promise.resolve(
        contagem === null ? null : { contagem, expiraEm: new Date(Date.now() + 3_600_000) },
      ),
    ler: () => Promise.resolve(null),
  };

  const medidor: MedidorDeNotificacoes = {
    contarEnvio: (tipo, resultado) => void envios.push({ tipo, resultado }),
    contarFalha: () => {
      estado.falhas += 1;
    },
    contarSupressao: (tipo, motivo) => void supressoes.push({ tipo, motivo }),
    observarEntrega: () => undefined,
  };

  const registrar = (dados: Record<string, unknown>): void => {
    linhas.push(dados);
  };

  const servico = criarServicoDeNotificacao({
    transporte,
    destinatarios: {
      emailDe: () => Promise.resolve(opcoes.email === undefined ? EMAIL : opcoes.email),
    },
    teto,
    maxPorHora: opcoes.maxPorHora ?? 5,
    logger: { info: registrar, warn: registrar, error: registrar } as unknown as Logger,
    medidor,
  });

  return {
    servico,
    enviadas,
    supressoes,
    envios,
    linhas,
    get falhas(): number {
      return estado.falhas;
    },
  };
}

describe('notificarUsuario', () => {
  it('resolve o endereço e entrega', async () => {
    const m = montar();

    await m.servico.notificarUsuario(USUARIO, 'senha_alterada', CORPO);

    expect(m.enviadas[0]?.para).toEqual([EMAIL]);
    expect(m.enviadas[0]?.assunto).toBe(CORPO.assunto);
    expect(m.envios).toEqual([{ tipo: 'senha_alterada', resultado: 'ok' }]);
  });

  it('sem endereço não manda, e diz por quê', async () => {
    const m = montar({ email: null });

    await m.servico.notificarUsuario(USUARIO, 'senha_alterada', CORPO);

    // Não há caminho de volta a partir da pista da trilha — é a anonimização funcionando.
    expect(m.enviadas).toHaveLength(0);
    expect(m.supressoes).toEqual([{ tipo: 'senha_alterada', motivo: 'sem_destinatario' }]);
  });
});

describe('teto por destinatário', () => {
  it('deixa passar quem está dentro da cota', async () => {
    const m = montar({ contagem: 5, maxPorHora: 5 });

    await m.servico.notificarUsuario(USUARIO, 'reset_de_senha', CORPO);

    expect(m.enviadas).toHaveLength(1);
  });

  it('corta quem passou do teto', async () => {
    const m = montar({ contagem: 6, maxPorHora: 5 });

    await m.servico.notificarUsuario(USUARIO, 'reset_de_senha', CORPO);

    // Sem isto, "esqueci minha senha" é um botão de inundar a caixa de entrada da vítima.
    expect(m.enviadas).toHaveLength(0);
    expect(m.supressoes).toEqual([{ tipo: 'reset_de_senha', motivo: 'teto' }]);
  });

  it('contador indisponível deixa passar', async () => {
    const m = montar({ contagem: null });

    await m.servico.notificarUsuario(USUARIO, 'login_novo', CORPO);

    // Fail open: negar transformaria queda do contador em silêncio total do canal.
    expect(m.enviadas).toHaveLength(1);
  });

  it('lista vazia de destinatários é supressão, não envio', async () => {
    const m = montar();

    const resultado = await m.servico.enviar({ tipo: 'teste', para: [], corpo: CORPO });

    expect(resultado.ok).toBe(false);
    expect(m.supressoes).toEqual([{ tipo: 'teste', motivo: 'sem_destinatario' }]);
  });
});

describe('falha de transporte', () => {
  it('conta a falha e devolve a causa', async () => {
    const m = montar({ entrega: { ok: false, causa: 'timeout' } });

    const resultado = await m.servico.notificarUsuario(USUARIO, 'login_novo', CORPO);

    expect(resultado).toEqual({ ok: false, causa: 'timeout' });
    expect(m.envios).toEqual([{ tipo: 'login_novo', resultado: 'erro' }]);
    expect(m.falhas).toBe(1);
  });

  it('não propaga exceção do transporte', async () => {
    const servico = criarServicoDeNotificacao({
      transporte: { enviar: () => Promise.reject(new Error('provedor explodiu')) },
      destinatarios: { emailDe: () => Promise.resolve(EMAIL) },
      teto: { incrementar: () => Promise.resolve(null), ler: () => Promise.resolve(null) },
      maxPorHora: 5,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    // Quem chama roda fora do caminho da requisição: uma rejeição aqui vira promessa solta.
    await expect(servico.notificarUsuario(USUARIO, 'login_novo', CORPO)).resolves.toEqual({
      ok: false,
      causa: 'indisponivel',
    });
  });
});

describe('o endereço não vai para o log', () => {
  it('nem no sucesso', async () => {
    const m = montar();

    await m.servico.notificarUsuario(USUARIO, 'login_novo', CORPO);

    expect(JSON.stringify(m.linhas)).not.toContain(EMAIL);
  });

  it('nem no erro', async () => {
    const m = montar({ entrega: { ok: false, causa: 'recusado' } });

    await m.servico.notificarUsuario(USUARIO, 'login_novo', CORPO);
    const inteiro = JSON.stringify(m.linhas);

    expect(inteiro).not.toContain(EMAIL);
    expect(inteiro).toContain('recusado');
  });

  it('nem o corpo da mensagem', async () => {
    const m = montar();

    await m.servico.enviar({
      tipo: 'reset_de_senha',
      para: [EMAIL],
      corpo: { ...CORPO, texto: 'https://conta/redefinir?token=token-secreto' },
    });

    expect(JSON.stringify(m.linhas)).not.toContain('token-secreto');
  });
});
