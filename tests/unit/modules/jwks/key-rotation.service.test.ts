/**
 * Cobre o serviço de rotação com repositório falso: a idempotência do preparo, a recusa de
 * promover antes da janela de pré-publicação, a invalidação de cache, o retorno ao repouso
 * com uma ativa e uma pré-publicada, e os caminhos de revogação — inclusive o que se recusa
 * a deixar o IdP sem chave de assinatura.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarKeyRotationService,
  type KeyRotationService,
} from '../../../../src/modules/jwks/services/key-rotation.service.js';
import { ErroDeRotacao } from '../../../../src/modules/jwks/errors/rotation.errors.js';
import type {
  EntradaDeChave,
  RepositorioJwks,
  ResultadoDeRotacao,
} from '../../../../src/modules/jwks/repositories/jwks.repository.js';
import type {
  ChaveJwks,
  MetadadosDeChave,
  StatusDaChave,
} from '../../../../src/modules/jwks/types/jwks.types.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const GRACA_MS = 15 * 60 * 1000;
const PREPUBLICACAO_MS = 10 * 60 * 1000;
const T0 = 1_800_000_000_000;

const logger = criarLogger({ nivel: 'fatal' });

interface RepoFake {
  readonly repo: RepositorioJwks;
  readonly chaves: Map<string, MetadadosDeChave>;
  avancar(ms: number): number;
  relogio(): number;
  ocuparLock(v: boolean): boolean;
}

/**
 * Repositório em memória com a mesma semântica do real: uma ativa, uma pré-publicada, a
 * rotação aposentando antes de promover e a revogação recusando-se a tocar na ativa.
 */
function repoFake(inicial: Partial<Record<StatusDaChave, string>> = {}): RepoFake {
  let relogio = T0;
  let lockOcupado = false;
  const chaves = new Map<string, MetadadosDeChave>();

  function por(status: StatusDaChave): MetadadosDeChave | undefined {
    return [...chaves.values()].find((c) => c.status === status);
  }

  function gravar(kid: string, status: StatusDaChave, criadaEm = relogio): void {
    chaves.set(kid, {
      kid,
      algorithm: 'EdDSA',
      status,
      criadaEm: new Date(criadaEm),
      ativadaEm: status === 'active' ? new Date(criadaEm) : null,
      aposentadaEm: null,
      verificavelAte: null,
    });
  }

  for (const [status, kid] of Object.entries(inicial)) {
    gravar(kid, status as StatusDaChave);
  }

  const repo: RepositorioJwks = {
    inserir(entrada: EntradaDeChave): Promise<ChaveJwks> {
      gravar(entrada.kid, entrada.status);
      const meta = chaves.get(entrada.kid) as MetadadosDeChave;
      return Promise.resolve({
        ...meta,
        publicJwk: entrada.publicJwk,
        privateKeyEnc: entrada.privateKeyEnc,
      });
    },
    rotacionar({ graceMs }): Promise<ResultadoDeRotacao> {
      if (lockOcupado) return Promise.resolve({ situacao: 'lock-ocupado' });
      const proxima = por('next');
      if (proxima === undefined) return Promise.resolve({ situacao: 'sem-proxima' });
      const anterior = por('active');
      if (anterior !== undefined) {
        chaves.set(anterior.kid, {
          ...anterior,
          status: 'retired',
          aposentadaEm: new Date(relogio),
          verificavelAte: new Date(relogio + graceMs),
        });
      }
      chaves.set(proxima.kid, {
        ...proxima,
        status: 'active',
        ativadaEm: new Date(relogio),
      });
      return Promise.resolve({
        situacao: 'rotacionada',
        kidAnterior: anterior?.kid ?? null,
        kidAtivo: proxima.kid,
      });
    },
    revogar(kid: string): Promise<MetadadosDeChave | null> {
      const alvo = chaves.get(kid);
      if (alvo === undefined || alvo.status === 'active') return Promise.resolve(null);
      const revogada: MetadadosDeChave = {
        ...alvo,
        status: 'retired',
        aposentadaEm: alvo.aposentadaEm ?? new Date(relogio),
        verificavelAte: new Date(relogio),
      };
      chaves.set(kid, revogada);
      return Promise.resolve(revogada);
    },
    purgar(margemMs: number): Promise<number> {
      let removidas = 0;
      for (const [kid, c] of chaves) {
        if (
          c.status === 'retired' &&
          c.verificavelAte !== null &&
          c.verificavelAte.getTime() < relogio - margemMs
        ) {
          chaves.delete(kid);
          removidas += 1;
        }
      }
      return Promise.resolve(removidas);
    },
    obterAtiva: () => Promise.resolve((por('active') ?? null) as ChaveJwks | null),
    obterProxima: () => Promise.resolve((por('next') ?? null) as ChaveJwks | null),
    obterMetadadosPorKid: (kid) => Promise.resolve(chaves.get(kid) ?? null),
    listarElegiveis: () => Promise.resolve([]),
    listarMetadados: () => Promise.resolve([...chaves.values()]),
    contarPorStatus: () =>
      Promise.resolve({
        active: [...chaves.values()].filter((c) => c.status === 'active').length,
        next: [...chaves.values()].filter((c) => c.status === 'next').length,
        retired: [...chaves.values()].filter((c) => c.status === 'retired').length,
      }),
  };

  return {
    repo,
    chaves,
    avancar: (ms: number) => (relogio += ms),
    relogio: () => relogio,
    ocuparLock: (v: boolean) => (lockOcupado = v),
  };
}

let fake: RepoFake;
let invalidarCache: ReturnType<typeof vi.fn>;
let service: KeyRotationService;

function montar(inicial: Partial<Record<StatusDaChave, string>> = {}): void {
  fake = repoFake(inicial);
  invalidarCache = vi.fn();
  service = criarKeyRotationService({
    repo: fake.repo,
    masterKey: MASTER,
    logger,
    invalidarCache,
    graceMs: GRACA_MS,
    prepublicacaoMinMs: PREPUBLICACAO_MS,
    purgaAposMs: 24 * 60 * 60 * 1000,
    agora: () => fake.relogio(),
  });
}

beforeEach(() => {
  montar({ active: 'kid-ativa' });
});

describe('prepararProxima', () => {
  it('cria a chave pré-publicada quando não há nenhuma', async () => {
    const preparada = await service.prepararProxima();

    expect(preparada.criada).toBe(true);
    expect((await fake.repo.obterProxima())?.kid).toBe(preparada.kid);
    expect(invalidarCache).toHaveBeenCalledTimes(1);
  });

  it('reaproveita a existente em vez de gerar outra', async () => {
    const primeira = await service.prepararProxima();
    invalidarCache.mockClear();

    const segunda = await service.prepararProxima();

    expect(segunda.kid).toBe(primeira.kid);
    expect(segunda.criada).toBe(false);
    expect((await fake.repo.contarPorStatus()).next).toBe(1);
    // Não houve mutação: nada a invalidar.
    expect(invalidarCache).not.toHaveBeenCalled();
  });

  it('informa a partir de quando a chave pode ser promovida', async () => {
    const preparada = await service.prepararProxima();

    expect(preparada.rotacionavelEm.getTime()).toBe(
      preparada.criadaEm.getTime() + PREPUBLICACAO_MS,
    );
  });
});

describe('rotacionar', () => {
  it('recusa quando não há chave pré-publicada', async () => {
    await expect(service.rotacionar()).rejects.toMatchObject({ codigo: 'sem-chave-proxima' });
  });

  // Promover antes da janela faria consumidores com JWKS em cache rejeitarem tokens
  // assinados por um kid que ainda não conhecem.
  it('recusa enquanto a pré-publicada não cumpriu a janela', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS - 1);

    const erro = await service.rotacionar().catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ErroDeRotacao);
    expect((erro as ErroDeRotacao).codigo).toBe('chave-proxima-recente');
    expect((erro as ErroDeRotacao).rotacionavelEm?.getTime()).toBe(T0 + PREPUBLICACAO_MS);
  });

  it('promove assim que a janela é cumprida', async () => {
    const preparada = await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);

    const resultado = await service.rotacionar();

    expect(resultado.kidAnterior).toBe('kid-ativa');
    expect(resultado.kidAtivo).toBe(preparada.kid);
  });

  it('volta ao repouso com uma ativa e uma pré-publicada', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);

    const resultado = await service.rotacionar();

    expect(await fake.repo.contarPorStatus()).toMatchObject({ active: 1, next: 1, retired: 1 });
    expect((await fake.repo.obterProxima())?.kid).toBe(resultado.kidProximo);
    expect(resultado.kidProximo).not.toBe(resultado.kidAtivo);
  });

  it('devolve até quando a chave aposentada ainda verifica', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);

    const resultado = await service.rotacionar();

    expect(resultado.verificavelAte?.getTime()).toBe(T0 + PREPUBLICACAO_MS + GRACA_MS);
  });

  it('invalida o cache depois da promoção e depois do novo preparo', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);
    invalidarCache.mockClear();

    await service.rotacionar();

    expect(invalidarCache).toHaveBeenCalledTimes(2);
  });

  it('traduz lock ocupado em rotação em andamento', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);
    fake.ocuparLock(true);

    await expect(service.rotacionar()).rejects.toMatchObject({ codigo: 'rotacao-em-andamento' });
  });

  it('conta a rotação com o motivo informado', async () => {
    const contarRotacao = vi.fn();
    fake = repoFake({ active: 'kid-ativa' });
    service = criarKeyRotationService({
      repo: fake.repo,
      masterKey: MASTER,
      logger,
      invalidarCache: vi.fn(),
      graceMs: GRACA_MS,
      prepublicacaoMinMs: PREPUBLICACAO_MS,
      purgaAposMs: 0,
      agora: () => fake.relogio(),
      medidor: {
        registrarContagem: vi.fn(),
        contarRotacao,
        registrarIdadeDaAtiva: vi.fn(),
      },
    });
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);

    await service.rotacionar({ motivo: 'scheduled' });

    expect(contarRotacao).toHaveBeenCalledWith('scheduled');
  });
});

describe('revogar', () => {
  it('recusa kid inexistente', async () => {
    await expect(service.revogar('kid-que-nao-existe', 'teste')).rejects.toMatchObject({
      codigo: 'chave-nao-encontrada',
    });
  });

  it('revoga a pré-publicada sem invalidar token nenhum', async () => {
    const preparada = await service.prepararProxima();

    const resultado = await service.revogar(preparada.kid, 'privada exposta');

    expect(resultado.tokensInvalidados).toBe(false);
    expect(resultado.kidAtivo).toBe('kid-ativa');
    expect(await fake.repo.obterProxima()).toBeNull();
  });

  // Sem candidata pronta, promover derrubaria todos os consumidores; falhar em voz alta é
  // o comportamento correto.
  it('recusa revogar a ativa quando não há pré-publicada', async () => {
    await expect(service.revogar('kid-ativa', 'comprometida')).rejects.toMatchObject({
      codigo: 'sem-chave-proxima',
    });
    expect((await fake.repo.obterAtiva())?.kid).toBe('kid-ativa');
  });

  it('revoga a ativa promovendo a pré-publicada no mesmo passo', async () => {
    const preparada = await service.prepararProxima();

    const resultado = await service.revogar('kid-ativa', 'privada em dump de log');

    expect(resultado.kidRevogado).toBe('kid-ativa');
    expect(resultado.kidAtivo).toBe(preparada.kid);
    expect(resultado.tokensInvalidados).toBe(true);
  });

  // A janela de pré-publicação protege contra downtime planejado; numa chave comprometida,
  // esperar dez minutos assinando com ela é pior que a rejeição temporária.
  it('revoga a ativa mesmo com a pré-publicada dentro da janela', async () => {
    await service.prepararProxima();

    await expect(service.revogar('kid-ativa', 'comprometida')).resolves.toMatchObject({
      tokensInvalidados: true,
    });
  });

  it('encerra a verificabilidade da chave revogada na hora', async () => {
    const preparada = await service.prepararProxima();

    await service.revogar('kid-ativa', 'comprometida');

    expect(fake.chaves.get('kid-ativa')?.verificavelAte?.getTime()).toBe(fake.relogio());
    expect(fake.chaves.get(preparada.kid)?.status).toBe('active');
  });

  it('recusa revogar chave que já parou de verificar', async () => {
    const preparada = await service.prepararProxima();
    await service.revogar(preparada.kid, 'primeira vez');

    await expect(service.revogar(preparada.kid, 'de novo')).rejects.toMatchObject({
      codigo: 'chave-ja-revogada',
    });
  });
});

describe('purgar e idade da ativa', () => {
  it('remove apenas o que já não verifica há mais que a margem', async () => {
    await service.prepararProxima();
    fake.avancar(PREPUBLICACAO_MS);
    await service.rotacionar();

    expect(await service.purgar()).toBe(0);

    fake.avancar(GRACA_MS + 24 * 60 * 60 * 1000 + 1);
    expect(await service.purgar()).toBe(1);
  });

  it('mede a idade da chave que assina agora', async () => {
    fake.avancar(90_000);

    expect(await service.idadeDaAtivaEmSegundos()).toBe(90);
  });

  it('devolve null quando não há chave ativa', async () => {
    montar({});

    expect(await service.idadeDaAtivaEmSegundos()).toBeNull();
  });
});
