/**
 * Responsabilidade: persistir e consumir refresh tokens opacos no MongoDB, com rotação
 * atômica e revogação por família.
 * Consumido por: o `RefreshTokenService`.
 * Regras:
 *  - Recebe o `Db` por injeção — nunca importa singleton de conexão. Índices (unique
 *    `token_hash`, `family_id`, TTL em `expires_at`) são de `indexes.ts`.
 *  - O token em claro nunca é gravado — só o `sha256` (`token_hash`).
 *  - `rotacionarAtomico` fecha a corrida: `findOneAndUpdate` filtrando `status: 'active'`,
 *    um único vencedor sob concorrência; os demais recebem `null`.
 *  - `expires_at` (alvo do TTL) é o teto absoluto da família, não a validade deslizante:
 *    tokens já rotacionados sobrevivem para a detecção de reuso até o fim da sessão.
 */
import type { Db } from 'mongodb';

const COLECAO = 'refresh_tokens';

export type StatusDeRefresh = 'active' | 'rotated' | 'revoked';

/** Projeção de domínio de um refresh token — o suficiente para o serviço decidir. */
export interface RefreshPersistido {
  readonly familyId: string;
  readonly userId: string;
  readonly status: StatusDeRefresh;
  readonly rotatedAt: Date | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface EntradaDeRegistro {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly userId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface RepositorioDeRefreshToken {
  /** Grava um refresh token novo (`active`); `expires_at` = teto absoluto (alvo do TTL). */
  registrar(entrada: EntradaDeRegistro): Promise<void>;
  /** Busca sem consumir; devolve `null` quando não existe. */
  buscarPorHash(tokenHash: string): Promise<RefreshPersistido | null>;
  /**
   * Marca `active → rotated` de forma atômica e devolve o documento **antes** da mudança,
   * ou `null` se já não estava `active` (outro pedido venceu a corrida).
   */
  rotacionarAtomico(tokenHash: string, agora: Date): Promise<RefreshPersistido | null>;
  /** Revoga todos os tokens ainda `active` de uma família (logout, reuso, bloqueio). */
  revogarFamilia(familyId: string): Promise<void>;
}

interface LinhaMongo {
  readonly token_hash: string;
  readonly family_id: string;
  readonly user_id: string;
  readonly status: StatusDeRefresh;
  readonly created_at: Date;
  readonly rotated_at: Date | null;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly expires_at: Date;
}

function paraDominio(linha: LinhaMongo): RefreshPersistido {
  return {
    familyId: linha.family_id,
    userId: linha.user_id,
    status: linha.status,
    rotatedAt: linha.rotated_at,
    idleExpiresAt: linha.idle_expires_at,
    absoluteExpiresAt: linha.absolute_expires_at,
  };
}

export function criarRepositorioDeRefreshToken(banco: Db): RepositorioDeRefreshToken {
  const colecao = banco.collection<LinhaMongo>(COLECAO);

  return {
    async registrar(entrada: EntradaDeRegistro): Promise<void> {
      await colecao.insertOne({
        token_hash: entrada.tokenHash,
        family_id: entrada.familyId,
        user_id: entrada.userId,
        status: 'active',
        created_at: new Date(),
        rotated_at: null,
        idle_expires_at: entrada.idleExpiresAt,
        absolute_expires_at: entrada.absoluteExpiresAt,
        expires_at: entrada.absoluteExpiresAt,
      });
    },

    async buscarPorHash(tokenHash: string): Promise<RefreshPersistido | null> {
      const linha = await colecao.findOne({ token_hash: tokenHash });
      return linha === null ? null : paraDominio(linha);
    },

    async rotacionarAtomico(tokenHash: string, agora: Date): Promise<RefreshPersistido | null> {
      const anterior = await colecao.findOneAndUpdate(
        { token_hash: tokenHash, status: 'active' },
        { $set: { status: 'rotated', rotated_at: agora } },
        { returnDocument: 'before' },
      );
      return anterior === null ? null : paraDominio(anterior);
    },

    async revogarFamilia(familyId: string): Promise<void> {
      await colecao.updateMany(
        { family_id: familyId, status: 'active' },
        { $set: { status: 'revoked' } },
      );
    },
  };
}
