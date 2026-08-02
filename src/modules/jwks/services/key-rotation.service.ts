/**
 * Responsabilidade: mover chaves entre estados — preparar a próxima, promovê-la e encerrar
 * uma chave comprometida.
 * Consumido por: as rotas administrativas de chaves e o agendador de rotação.
 * Regras:
 *  - A promoção só acontece depois que a chave pré-publicada cumpriu a janela de
 *    pré-publicação. Promover antes faria consumidores com JWKS em cache rejeitarem tokens
 *    de um `kid` que ainda não conhecem — o downtime que a rotação em duas fases evita.
 *  - Toda mutação invalida o cache local do serviço de chaves. Outras réplicas recarregam
 *    pelo TTL, cujo teto o boot garante ser menor que a janela de graça.
 *  - Ao final de uma rotação o sistema volta ao repouso com uma ativa e uma pré-publicada.
 *  - Log só com `kid`, motivo e ator; material de chave nunca sai daqui.
 */
import { cifrarPrivada } from '../../../shared/crypto/key-envelope.js';
import type { Logger } from '../../../shared/logger/index.js';
import type { RepositorioJwks } from '../repositories/jwks.repository.js';
import type { MetadadosDeChave } from '../types/jwks.types.js';
import { ErroDeRotacao } from '../errors/rotation.errors.js';
import { gerarParEd25519 } from './key-factory.js';
import { medidorDeJwksNulo, type MedidorDeJwks } from '../metrics/jwks.metrics.js';

/** Por que a rotação aconteceu — vira rótulo de métrica, então é lista fechada. */
export type MotivoDeRotacao = 'manual' | 'scheduled' | 'revocation';

export interface ConfiguracaoDeRotacao {
  readonly repo: RepositorioJwks;
  readonly masterKey: string;
  readonly logger: Logger;
  /** Invalida o cache do conjunto de chaves após cada mutação. */
  readonly invalidarCache: () => void;
  /** Janela em que a chave aposentada ainda verifica tokens já emitidos. */
  readonly graceMs: number;
  /** Tempo mínimo que a pré-publicada precisa ficar visível antes de assinar. */
  readonly prepublicacaoMinMs: number;
  /** Margem após o fim da verificabilidade antes de a linha ser apagada. */
  readonly purgaAposMs: number;
  readonly medidor?: MedidorDeJwks;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface ChavePreparada {
  readonly kid: string;
  readonly criadaEm: Date;
  /** Instante a partir do qual esta chave pode ser promovida. */
  readonly rotacionavelEm: Date;
  /** `false` quando já havia uma pré-publicada e ela foi reaproveitada. */
  readonly criada: boolean;
}

export interface ResultadoDeRotacaoDeChave {
  readonly kidAnterior: string | null;
  readonly kidAtivo: string;
  readonly kidProximo: string;
  /** Até quando a chave aposentada ainda verifica tokens. */
  readonly verificavelAte: Date | null;
}

export interface ResultadoDeRevogacao {
  readonly kidRevogado: string;
  readonly kidAtivo: string | null;
  /** `true` quando a chave chegou a assinar algo que ainda poderia estar em uso. */
  readonly tokensInvalidados: boolean;
}

export interface KeyRotationService {
  prepararProxima(ator?: string): Promise<ChavePreparada>;
  rotacionar(opcoes?: {
    motivo?: MotivoDeRotacao;
    ator?: string | undefined;
  }): Promise<ResultadoDeRotacaoDeChave>;
  revogar(kid: string, motivo: string, ator?: string): Promise<ResultadoDeRevogacao>;
  /** Remove chaves que já não verificam nada. Devolve quantas saíram. */
  purgar(): Promise<number>;
  /** Idade da chave ativa em segundos; `null` quando não há ativa. */
  idadeDaAtivaEmSegundos(): Promise<number | null>;
}

export function criarKeyRotationService(config: ConfiguracaoDeRotacao): KeyRotationService {
  const agora = config.agora ?? Date.now;
  const medidor = config.medidor ?? medidorDeJwksNulo();

  /** Gera, cifra e insere uma chave pré-publicada. */
  async function inserirProxima(): Promise<MetadadosDeChave> {
    const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
    return config.repo.inserir({
      kid,
      algorithm: 'EdDSA',
      publicJwk,
      privateKeyEnc: cifrarPrivada(privateKeyDer, config.masterKey),
      status: 'next',
    });
  }

  function rotacionavelEm(criadaEm: Date): Date {
    return new Date(criadaEm.getTime() + config.prepublicacaoMinMs);
  }

  async function atualizarMedidor(): Promise<void> {
    medidor.registrarContagem(await config.repo.contarPorStatus());
    medidor.registrarIdadeDaAtiva(await idadeDaAtiva());
  }

  async function idadeDaAtiva(): Promise<number | null> {
    const ativa = await config.repo.obterAtiva();
    // `ativadaEm` é nulo em chave que nunca assinou; a criação é o piso razoável de idade.
    const referencia = ativa?.ativadaEm ?? ativa?.criadaEm;
    return referencia === undefined
      ? null
      : Math.max(0, Math.round((agora() - referencia.getTime()) / 1000));
  }

  /**
   * Promove a pré-publicada com a janela informada.
   *
   * Janela zero é a revogação de emergência: a mesma transação, com a chave aposentada
   * deixando de verificar no ato em vez de ao fim da graça.
   */
  async function promover(
    graceMs: number,
    motivo: MotivoDeRotacao,
    ator: string | undefined,
  ): Promise<ResultadoDeRotacaoDeChave> {
    const proxima = await config.repo.obterProxima();
    if (proxima === null) {
      throw new ErroDeRotacao('sem-chave-proxima');
    }

    // A checagem da janela é do serviço, não do SQL: o repositório executa a transação, a
    // política de quando ela é segura é regra de negócio.
    const liberadaEm = rotacionavelEm(proxima.criadaEm);
    if (motivo !== 'revocation' && agora() < liberadaEm.getTime()) {
      throw new ErroDeRotacao('chave-proxima-recente', liberadaEm);
    }

    const resultado = await config.repo.rotacionar({ graceMs });
    if (resultado.situacao === 'lock-ocupado') {
      throw new ErroDeRotacao('rotacao-em-andamento');
    }
    if (resultado.situacao === 'sem-proxima') {
      // A pré-publicada existia na leitura acima e sumiu antes do commit: outra réplica
      // rotacionou no meio. Do ponto de vista de quem pediu, é concorrência, não ausência.
      throw new ErroDeRotacao('rotacao-em-andamento');
    }

    config.invalidarCache();

    // Repouso é sempre uma ativa mais uma pré-publicada: quem rotacionar em seguida já
    // encontra candidata, e a janela de pré-publicação começa a correr agora.
    const nova = await inserirProxima();
    config.invalidarCache();

    const aposentada =
      resultado.kidAnterior === null
        ? null
        : await config.repo.obterMetadadosPorKid(resultado.kidAnterior);

    medidor.contarRotacao(motivo);
    await atualizarMedidor();
    config.logger.info(
      {
        kid_anterior: resultado.kidAnterior,
        kid_novo: resultado.kidAtivo,
        motivo,
        ator_id: ator ?? null,
      },
      'jwks.rotate: chave promovida',
    );

    return {
      kidAnterior: resultado.kidAnterior,
      kidAtivo: resultado.kidAtivo,
      kidProximo: nova.kid,
      verificavelAte: aposentada?.verificavelAte ?? null,
    };
  }

  return {
    async prepararProxima(ator?: string): Promise<ChavePreparada> {
      const existente = await config.repo.obterProxima();
      if (existente !== null) {
        return {
          kid: existente.kid,
          criadaEm: existente.criadaEm,
          rotacionavelEm: rotacionavelEm(existente.criadaEm),
          criada: false,
        };
      }

      const nova = await inserirProxima();
      config.invalidarCache();
      await atualizarMedidor();
      config.logger.info(
        { kid_anterior: null, kid_novo: nova.kid, motivo: 'prepare', ator_id: ator ?? null },
        'jwks.prepare: chave pré-publicada criada',
      );

      return {
        kid: nova.kid,
        criadaEm: nova.criadaEm,
        rotacionavelEm: rotacionavelEm(nova.criadaEm),
        criada: true,
      };
    },

    async rotacionar(opcoes = {}): Promise<ResultadoDeRotacaoDeChave> {
      return promover(config.graceMs, opcoes.motivo ?? 'manual', opcoes.ator);
    },

    async revogar(kid: string, motivo: string, ator?: string): Promise<ResultadoDeRevogacao> {
      const alvo = await config.repo.obterMetadadosPorKid(kid);
      if (alvo === null) {
        throw new ErroDeRotacao('chave-nao-encontrada');
      }
      if (alvo.verificavelAte !== null && alvo.verificavelAte.getTime() <= agora()) {
        throw new ErroDeRotacao('chave-ja-revogada');
      }

      if (alvo.status === 'active') {
        // Revogar a ativa é promover a pré-publicada com janela zero: sem isso o IdP
        // ficaria sem chave de assinatura. Sem candidata, falha em voz alta — promover uma
        // chave que ninguém conhece derrubaria todos os consumidores de uma vez.
        const rotacao = await promover(0, 'revocation', ator);
        config.logger.info(
          { kid_anterior: kid, kid_novo: rotacao.kidAtivo, motivo, ator_id: ator ?? null },
          'jwks.revoke: chave ativa revogada e substituída',
        );
        return { kidRevogado: kid, kidAtivo: rotacao.kidAtivo, tokensInvalidados: true };
      }

      const revogada = await config.repo.revogar(kid);
      if (revogada === null) {
        // A chave virou ativa entre a leitura e o UPDATE — o SQL protege esse caso.
        throw new ErroDeRotacao('rotacao-em-andamento');
      }

      config.invalidarCache();
      await atualizarMedidor();
      config.logger.info(
        { kid_anterior: kid, kid_novo: null, motivo, ator_id: ator ?? null },
        'jwks.revoke: chave revogada',
      );

      const ativa = await config.repo.obterAtiva();
      return {
        kidRevogado: kid,
        kidAtivo: ativa?.kid ?? null,
        // Uma chave pré-publicada nunca assinou nada: não há token para invalidar.
        tokensInvalidados: alvo.status !== 'next',
      };
    },

    async purgar(): Promise<number> {
      const removidas = await config.repo.purgar(config.purgaAposMs);
      if (removidas > 0) {
        await atualizarMedidor();
        config.logger.info({ removidas, motivo: 'purge' }, 'jwks.purge: chaves removidas');
      }
      return removidas;
    },

    idadeDaAtivaEmSegundos: idadeDaAtiva,
  };
}
