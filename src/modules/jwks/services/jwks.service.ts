/**
 * Responsabilidade: fornecer a chave ativa para assinatura e o conjunto público de
 * verificação, com cache em memória e decifra fail-closed no boot.
 * Consumido por: o endpoint `/.well-known/jwks.json` e o serviço de emissão de tokens.
 * Regras:
 *  - `iniciar()` decifra a chave active uma vez. `MASTER_KEY` ausente/errada com active
 *    presente ⇒ erro (o server.ts converte em exit 1). Fail closed: o processo não sobe sem
 *    poder assinar/verificar, em vez de servir tokens não-verificáveis.
 *  - Cache com invalidação explícita + TTL de segurança (cobre réplicas sem event bus).
 *  - A privada decifrada fica encapsulada em `ChavePrivada` — mesmo o estado interno do
 *    serviço, se inspecionado, não vaza o material.
 */
import { createPrivateKey } from 'node:crypto';
import { createLocalJWKSet } from 'jose';
import { decifrarPrivada } from '../../../shared/crypto/key-envelope.js';
import { ChavePrivada } from '../../../shared/crypto/private-key.js';
import type { RepositorioJwks } from '../repositories/jwks.repository.js';
import type { JwkPublica } from '../types/jwks.types.js';
import { medidorDeJwksNulo, type MedidorDeJwks } from '../metrics/jwks.metrics.js';

/** Conjunto de verificação do jose (seleção automática por `kid`). */
export type ConjuntoDeVerificacao = ReturnType<typeof createLocalJWKSet>;

/** A chave active pronta para assinar. `privateKey` é o wrapper anti-vazamento. */
export interface ChaveAtiva {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly privateKey: ChavePrivada;
}

export interface ConfiguracaoJwks {
  readonly repo: RepositorioJwks;
  /** Segredo para decifrar a privada. Ausente só é tolerado se não houver chave active. */
  readonly masterKey?: string;
  /** Janela de graça das chaves retired (ms). */
  readonly graceMs: number;
  /** TTL de segurança do cache (ms). */
  readonly cacheTtlMs: number;
  readonly medidor?: MedidorDeJwks;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface JwksService {
  /** Carrega e valida as chaves no boot (fail closed). */
  iniciar(): Promise<void>;
  /** Chave active para assinatura. @throws se não houver active. */
  obterChaveAtiva(): Promise<ChaveAtiva>;
  /** Conjunto do jose para `jwtVerify` (active + next + retired-em-graça). */
  obterConjuntoDeVerificacao(): Promise<ConjuntoDeVerificacao>;
  /** Chaves públicas elegíveis para publicar no endpoint JWKS. */
  obterConjuntoPublico(): Promise<{ keys: JwkPublica[] }>;
  /** Descarta o cache — força recarga na próxima leitura (usado na rotação de chaves). */
  invalidar(): void;
}

interface EstadoDoCache {
  readonly chaveAtiva: ChaveAtiva | null;
  readonly conjuntoPublico: { keys: JwkPublica[] };
  readonly verificacao: ConjuntoDeVerificacao;
  readonly carregadoEm: number;
}

export function criarJwksService(config: ConfiguracaoJwks): JwksService {
  const agora = config.agora ?? Date.now;
  const medidor = config.medidor ?? medidorDeJwksNulo();

  let estado: EstadoDoCache | undefined;
  let carregando: Promise<EstadoDoCache> | undefined;

  async function carregar(): Promise<EstadoDoCache> {
    const [elegiveis, ativa, contagem] = await Promise.all([
      config.repo.listarElegiveis(new Date(agora()), config.graceMs),
      config.repo.obterAtiva(),
      config.repo.contarPorStatus(),
    ]);

    let chaveAtiva: ChaveAtiva | null = null;
    if (ativa !== null) {
      if (config.masterKey === undefined) {
        throw new Error('MASTER_KEY ausente: há chave active a decifrar (fail closed)');
      }
      // decifrarPrivada lança se a MASTER_KEY estiver errada (tag GCM) — fail closed.
      const der = decifrarPrivada(ativa.privateKeyEnc, config.masterKey);
      const keyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      chaveAtiva = { kid: ativa.kid, algorithm: 'EdDSA', privateKey: new ChavePrivada(keyObject) };
    }

    const keys = elegiveis.map((c) => c.publicJwk);
    medidor.registrarContagem(contagem);

    return {
      chaveAtiva,
      conjuntoPublico: { keys },
      // createLocalJWKSet espera JWKs mutáveis; a cópia evita expor o array do cache.
      verificacao: createLocalJWKSet({ keys: keys.map((k) => ({ ...k })) }),
      carregadoEm: agora(),
    };
  }

  async function garantir(): Promise<EstadoDoCache> {
    if (estado !== undefined && agora() - estado.carregadoEm <= config.cacheTtlMs) {
      return estado;
    }
    carregando ??= carregar()
      .then((novo) => {
        estado = novo;
        carregando = undefined;
        return novo;
      })
      .catch((erro: unknown) => {
        carregando = undefined;
        throw erro;
      });
    return carregando;
  }

  return {
    async iniciar(): Promise<void> {
      await garantir();
    },

    async obterChaveAtiva(): Promise<ChaveAtiva> {
      const { chaveAtiva } = await garantir();
      if (chaveAtiva === null) {
        throw new Error('nenhuma chave active disponível para assinatura');
      }
      return chaveAtiva;
    },

    async obterConjuntoDeVerificacao(): Promise<ConjuntoDeVerificacao> {
      return (await garantir()).verificacao;
    },

    async obterConjuntoPublico(): Promise<{ keys: JwkPublica[] }> {
      return (await garantir()).conjuntoPublico;
    },

    invalidar(): void {
      estado = undefined;
    },
  };
}
