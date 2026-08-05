/**
 * Cobre o serviço que escreve na trilha.
 *
 * Três propriedades sustentam tudo o que vem depois: o hash é o do elo (posição + anterior +
 * corpo), segredo nenhum atravessa a validação, e falha de escrita não derruba a operação
 * que gerou o evento — ela vira log e contador.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from 'pino';
import { criarAuditService } from '../../../../src/modules/audit/services/audit.service.js';
import { calcularHashDoElo } from '../../../../src/modules/audit/services/chain-hash.js';
import { HASH_DE_GENESE } from '../../../../src/modules/audit/types/audit-event.js';
import type { EventoDeAuditoria } from '../../../../src/modules/audit/types/audit-event.js';
import type {
  EventoParaAnexar,
  RepositorioDaTrilha,
  ResultadoDeAnexo,
} from '../../../../src/modules/audit/repositories/audit-log.repository.js';
import type { RepositorioDeCheckpoint } from '../../../../src/modules/audit/repositories/audit-checkpoint.repository.js';
import type { MedidorDeAuditoria } from '../../../../src/modules/audit/metrics/audit.metrics.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';

/** Trilha em memória que reproduz o encadeamento, para o teste ver o hash real. */
function trilhaFalsa(perdasAntesDeVencer = 0): RepositorioDaTrilha & {
  readonly anexados: EventoParaAnexar[];
} {
  const anexados: EventoParaAnexar[] = [];
  let seq = 0;
  let hashDoTopo = HASH_DE_GENESE;

  return {
    anexados,
    garantirGenese: () => Promise.resolve(),
    topo: () => Promise.resolve({ seq, hash: hashDoTopo }),
    anexar(base, calcularHash): Promise<ResultadoDeAnexo> {
      // Cada perda simulada gasta uma volta antes de a posição ser aceita.
      const tentativas = perdasAntesDeVencer + 1;
      const prevHash = hashDoTopo;
      seq += 1;
      const hash = calcularHash(seq, prevHash);
      hashDoTopo = hash;
      anexados.push(base);
      return Promise.resolve({
        evento: {
          ...base,
          seq,
          prevHash,
          hash,
        },
        tentativas,
      });
    },
    buscarPorSeq: () => Promise.resolve(null),
    listar: () => Promise.resolve({ itens: [], proximoCursor: null, temMais: false }),
    lerFaixa: () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }),
  };
}

function checkpointsFalsos(): RepositorioDeCheckpoint & { readonly gravados: number[] } {
  const gravados: number[] = [];
  return {
    gravados,
    gravar: (seq) => {
      gravados.push(seq);
      return Promise.resolve();
    },
    ultimoAte: () => Promise.resolve(null),
    ultimo: () => Promise.resolve(null),
  };
}

interface LoggerFalso {
  readonly logger: Logger;
  readonly error: Mock;
  readonly warn: Mock;
}

/** Os mocks saem separados do objeto: asserção sobre método destacado dispara unbound-method. */
function loggerFalso(): LoggerFalso {
  const error = vi.fn();
  const warn = vi.fn();
  return { logger: { error, warn, info: vi.fn() } as unknown as Logger, error, warn };
}

interface MedidorFalso {
  readonly medidor: MedidorDeAuditoria;
  readonly contarEvento: Mock;
  readonly contarFalha: Mock;
  readonly contarConflito: Mock;
}

function medidorFalso(): MedidorFalso {
  const contarEvento = vi.fn();
  const contarFalha = vi.fn();
  const contarConflito = vi.fn();
  return {
    medidor: {
      contarEvento,
      contarFalha,
      contarConflito,
      observarEscrita: vi.fn(),
      registrarCheckpoint: vi.fn(),
    },
    contarEvento,
    contarFalha,
    contarConflito,
  };
}

function evento(sobrescritas: Partial<EventoDeAuditoria> = {}): EventoDeAuditoria {
  return {
    type: 'iam.auth.login',
    actor: { id: 'u1', type: 'user', ip: '203.0.113.10' },
    outcome: 'success',
    ...sobrescritas,
  };
}

function montar(
  opcoes: {
    trilha?: ReturnType<typeof trilhaFalsa>;
    checkpoints?: ReturnType<typeof checkpointsFalsos>;
    checkpointACada?: number;
  } = {},
): {
  servico: ReturnType<typeof criarAuditService>;
  trilha: ReturnType<typeof trilhaFalsa>;
  checkpoints: ReturnType<typeof checkpointsFalsos>;
  log: LoggerFalso;
  medicao: MedidorFalso;
} {
  const trilha = opcoes.trilha ?? trilhaFalsa();
  const checkpoints = opcoes.checkpoints ?? checkpointsFalsos();
  const log = loggerFalso();
  const medicao = medidorFalso();
  const servico = criarAuditService({
    trilha,
    checkpoints,
    logger: log.logger,
    medidor: medicao.medidor,
    pepper: PEPPER,
    checkpointACada: opcoes.checkpointACada ?? 100,
  });
  return { servico, trilha, checkpoints, log, medicao };
}

describe('registrar — encadeamento', () => {
  it('calcula o hash do elo sobre a posição, o anterior e o corpo do evento', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento());

    const base = trilha.anexados[0];
    expect(base).toBeDefined();
    if (base === undefined) return;
    const esperado = calcularHashDoElo(1, HASH_DE_GENESE, base);
    expect((await trilha.topo()).hash).toBe(esperado);
  });

  it('parte da gênese com 64 zeros', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento());

    expect(HASH_DE_GENESE).toBe('0'.repeat(64));
    expect((await trilha.topo()).seq).toBe(1);
  });

  it('gera um event_id por evento e carimba o instante', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento());
    await servico.registrar(evento());

    const [primeiro, segundo] = trilha.anexados;
    expect(primeiro?.eventId).not.toBe(segundo?.eventId);
    expect(primeiro?.occurredAt).toBeInstanceOf(Date);
  });
});

describe('registrar — segredo fora da trilha', () => {
  it.each([
    ['senha', { senha: 'x' }],
    ['password_hash', { password_hash: 'x' }],
    ['refresh_token', { refresh_token: 'x' }],
    ['client_secret', { client_secret: 'x' }],
    ['authorization', { authorization: 'x' }],
  ])('recusa metadata com %s antes de escrever', async (_nome, metadata) => {
    const { servico, trilha, medicao } = montar();

    await servico.registrar(evento({ metadata }));

    expect(trilha.anexados).toHaveLength(0);
    expect(medicao.contarFalha).toHaveBeenCalledWith('metadata-proibida');
  });

  it('loga só os nomes das chaves recusadas, nunca os valores', async () => {
    const { servico, log } = montar();

    await servico.registrar(evento({ metadata: { senha: 'super-secreta' } }));

    const chamada = JSON.stringify(log.error.mock.calls[0]);
    expect(chamada).toContain('senha');
    expect(chamada).not.toContain('super-secreta');
  });

  it('aceita metadata sem chave sensível', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento({ metadata: { role_ids: ['r1'], total: 2 } }));

    expect(trilha.anexados[0]?.metadata).toEqual({ role_ids: ['r1'], total: 2 });
  });
});

describe('registrar — sujeito sem ator identificado', () => {
  it('guarda o hash do e-mail com pepper, e não o e-mail', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(
      evento({
        type: 'iam.auth.login_failed',
        actor: { id: null, type: 'user' },
        outcome: 'failure',
        reason: 'invalid_credentials',
        subjectEmail: 'Alguem@Exemplo.com',
      }),
    );

    const base = trilha.anexados[0];
    expect(base?.subjectHint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(base)).not.toContain('Alguem@Exemplo.com');
    expect(JSON.stringify(base)).not.toContain('alguem@exemplo.com');
  });

  it('deriva a mesma pista para o mesmo e-mail, ignorando caixa e espaços', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento({ subjectEmail: 'a@b.com' }));
    await servico.registrar(evento({ subjectEmail: '  A@B.COM  ' }));

    expect(trilha.anexados[0]?.subjectHint).toBe(trilha.anexados[1]?.subjectHint);
  });

  it('deixa a pista nula quando não há e-mail envolvido', async () => {
    const { servico, trilha } = montar();

    await servico.registrar(evento());

    expect(trilha.anexados[0]?.subjectHint).toBeNull();
  });
});

describe('registrar — contenção do topo', () => {
  it('conta as voltas perdidas na disputa e ainda escreve um único evento', async () => {
    const { servico, trilha, medicao } = montar({ trilha: trilhaFalsa(3) });

    await servico.registrar(evento());

    expect(trilha.anexados).toHaveLength(1);
    expect(medicao.contarConflito).toHaveBeenCalledWith(3);
  });

  it('não conta conflito quando vence de primeira', async () => {
    const { servico, medicao } = montar();

    await servico.registrar(evento());

    expect(medicao.contarConflito).toHaveBeenCalledWith(0);
  });
});

describe('registrar — falha de escrita', () => {
  it('não propaga o erro: a operação que gerou o evento não pode cair junto', async () => {
    const trilha = trilhaFalsa();
    trilha.anexar = () => Promise.reject(new Error('mongo fora'));
    const { servico } = montar({ trilha });

    await expect(servico.registrar(evento())).resolves.toBeUndefined();
  });

  it('loga o evento íntegro em error e conta a falha', async () => {
    const trilha = trilhaFalsa();
    trilha.anexar = () => Promise.reject(new Error('mongo fora'));
    const { servico, log, medicao } = montar({ trilha });

    await servico.registrar(evento({ type: 'iam.user.blocked' }));

    expect(JSON.stringify(log.error.mock.calls[0])).toContain('iam.user.blocked');
    expect(medicao.contarFalha).toHaveBeenCalledWith('escrita');
  });
});

describe('registrar — âncora periódica', () => {
  it('ancora quando a posição fecha o intervalo configurado', async () => {
    const { servico, checkpoints } = montar({ checkpointACada: 2 });

    await servico.registrar(evento());
    await servico.registrar(evento());
    await servico.registrar(evento());
    await servico.registrar(evento());

    expect(checkpoints.gravados).toEqual([2, 4]);
  });

  it('não ancora nas posições intermediárias', async () => {
    const { servico, checkpoints } = montar({ checkpointACada: 100 });

    await servico.registrar(evento());

    expect(checkpoints.gravados).toEqual([]);
  });

  it('falha ao ancorar não desfaz nem esconde o evento já escrito', async () => {
    const checkpoints = checkpointsFalsos();
    checkpoints.gravar = () => Promise.reject(new Error('postgres fora'));
    const { servico, trilha, log, medicao } = montar({ checkpoints, checkpointACada: 1 });

    await expect(servico.registrar(evento())).resolves.toBeUndefined();

    expect(trilha.anexados).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
    expect(medicao.contarFalha).not.toHaveBeenCalled();
  });
});
