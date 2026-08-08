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
  /** Cliente dono da família; `null` quando o token nasceu no login por senha. */
  readonly clientId: string | null;
  /** Escopo concedido na emissão. A rotação não pode ampliá-lo (RFC 6749 §6). */
  readonly escopo: string | null;
  /** Força da autenticação que criou a família. Ausente é lido como `['pwd']`. */
  readonly amr: readonly string[];
}

export interface EntradaDeRegistro {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly userId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly clientId?: string | null;
  readonly escopo?: string | null;
  readonly amr?: readonly string[] | null;
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
  /**
   * Revoga todos os tokens ainda `active` do usuário, em todas as famílias — o que
   * bloqueio, remoção e troca de senha precisam: derrubar as sessões que existirem, sem
   * que quem chama saiba quantas famílias o usuário tem abertas.
   */
  revogarDoUsuario(userId: string): Promise<void>;
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
  // Opcionais na leitura: documento gravado antes do vínculo com cliente não tem os campos,
  // e ausente é lido como `null` — o que o mantém resgatável só por `/auth/refresh`.
  readonly client_id?: string | null;
  readonly scope?: string | null;
  readonly amr?: readonly string[] | null;
}

function paraDominio(linha: LinhaMongo): RefreshPersistido {
  return {
    familyId: linha.family_id,
    userId: linha.user_id,
    status: linha.status,
    rotatedAt: linha.rotated_at,
    idleExpiresAt: linha.idle_expires_at,
    absoluteExpiresAt: linha.absolute_expires_at,
    clientId: linha.client_id ?? null,
    escopo: linha.scope ?? null,
    // Documento anterior ao segundo fator não tem o campo: aquela sessão nasceu de senha.
    amr: linha.amr ?? ['pwd'],
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
        client_id: entrada.clientId ?? null,
        scope: entrada.escopo ?? null,
        amr: entrada.amr ?? ['pwd'],
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

    async revogarDoUsuario(userId: string): Promise<void> {
      await colecao.updateMany(
        { user_id: userId, status: 'active' },
        { $set: { status: 'revoked' } },
      );
    },
  };
}
