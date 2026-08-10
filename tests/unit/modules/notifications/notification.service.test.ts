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
const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

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
    contagem?: number;
    /** Contador fora do ar: `incrementar` devolve `null`, que é "não sei". */
    contadorFora?: boolean;
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

  const contagem = opcoes.contagem ?? 1;
  const teto: ContadorDeRateLimit = {
    incrementar: () =>
      Promise.resolve(
        opcoes.contadorFora === true
          ? null
          : { contagem, expiraEm: new Date(Date.now() + 3_600_000) },
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
    pepper: PEPPER,
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

  it('aviso ao usuário e alerta à operação contam em baldes separados', async () => {
    const chaves: string[] = [];
    const servico = criarServicoDeNotificacao({
      transporte: { enviar: () => Promise.resolve({ ok: true as const }) },
      destinatarios: { emailDe: () => Promise.resolve(EMAIL) },
      teto: {
        incrementar: (chave) => {
          chaves.push(chave);
          return Promise.resolve({ contagem: 1, expiraEm: new Date() });
        },
        ler: () => Promise.resolve(null),
      },
      maxPorHora: 5,
      pepper: PEPPER,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    await servico.enviar({ tipo: 'login_novo', para: [EMAIL], corpo: CORPO });
    await servico.enviar({ tipo: 'alerta_de_seguranca', para: [EMAIL], corpo: CORPO });
    await servico.enviar({ tipo: 'teste', para: [EMAIL], corpo: CORPO });

    // O canal que denuncia o incidente não pode se calar por causa do volume de mensagens a
    // usuários — nem por causa de um administrador rodando a mensagem de teste.
    expect(chaves[0]).toContain(':usuario:');
    expect(chaves[1]).toContain(':operacao:');
    expect(chaves[1]).toBe(chaves[2]);
    expect(chaves[0]).not.toBe(chaves[1]);
  });

  it('contador indisponível deixa passar', async () => {
    const m = montar({ contadorFora: true });

    await m.servico.notificarUsuario(USUARIO, 'login_novo', CORPO);

    // Fail open: negar transformaria queda do contador em silêncio total do canal.
    expect(m.enviadas).toHaveLength(1);
  });

  it('lista vazia de destinatários é supressão, não envio', async () => {
    const m = montar();

    const resultado = await m.servico.enviar({ tipo: 'teste', para: [], corpo: CORPO });

    expect(resultado).toEqual({ ok: false, suprimida: 'sem_destinatario' });
    expect(m.supressoes).toEqual([{ tipo: 'teste', motivo: 'sem_destinatario' }]);
  });

  it('supressão não se passa por falha de transporte', async () => {
    const m = montar({ contagem: 99, maxPorHora: 5 });

    const resultado = await m.servico.notificarUsuario(USUARIO, 'teste', CORPO);

    // "Estourou a cota" e "o provedor caiu" pedem ações opostas de quem investiga; achatar
    // os dois em `causa` faz o diagnóstico apontar para a variável de ambiente errada.
    expect(resultado).toEqual({ ok: false, suprimida: 'teto' });
    expect(resultado).not.toHaveProperty('causa');
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
      pepper: PEPPER,
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
