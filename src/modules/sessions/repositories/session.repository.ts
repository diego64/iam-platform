/**
 * Responsabilidade: persistir e consultar os metadados das sessões ativas no MongoDB.
 * Consumido por: o serviço de sessões.
 * Regras:
 *  - Recebe o `Db` por injeção — nunca importa singleton de conexão. Índices (único em
 *    `session_id`, composto `user_id`+`status`, TTL em `expires_at`) são de `indexes.ts`.
 *  - Toda leitura e escrita é escopada por dono onde faz sentido: a listagem filtra por
 *    `user_id`, e a checagem de posse confirma antes de qualquer revogação.
 *  - `expires_at` é o teto absoluto da família — o TTL apaga o registro junto com a família.
 */
import type { Db } from 'mongodb';

const COLECAO = 'active_sessions';

export type StatusDeSessao = 'active' | 'revoked';

/** Projeção de uma sessão ativa — o suficiente para montar o DTO da listagem. */
export interface SessaoAtiva {
  readonly sessionId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface DadosDeInicio {
  readonly sessionId: string;
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly expiraEm: Date;
}

export interface RepositorioDeSessoes {
  iniciar(dados: DadosDeInicio): Promise<void>;
  /** Atualiza "visto por último" de uma sessão ainda ativa. */
  tocar(sessionId: string): Promise<void>;
  /** Sessões ativas e não expiradas do usuário, mais recentes primeiro. */
  listarAtivas(userId: string): Promise<SessaoAtiva[]>;
  /** `session_id`s ativos do usuário — base para "encerrar as demais". */
  idsAtivasDoUsuario(userId: string): Promise<string[]>;
  /** Confirma que a sessão existe e é do usuário (a base do 404 uniforme). */
  pertenceAoUsuario(sessionId: string, userId: string): Promise<boolean>;
  /** Marca a sessão como revogada — chamado quando a família correspondente é encerrada. */
  marcarRevogada(sessionId: string): Promise<void>;
}

interface LinhaMongo {
  readonly session_id: string;
  readonly user_id: string;
  readonly status: StatusDeSessao;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
  readonly expires_at: Date;
}

export function criarRepositorioDeSessoes(banco: Db): RepositorioDeSessoes {
  const colecao = banco.collection<LinhaMongo>(COLECAO);

  return {
    async iniciar(dados: DadosDeInicio): Promise<void> {
      const agora = new Date();
      // Upsert por session_id: idempotente se o login for reentrante para a mesma família.
      await colecao.updateOne(
        { session_id: dados.sessionId },
        {
          $setOnInsert: {
            session_id: dados.sessionId,
            user_id: dados.userId,
            status: 'active',
            ip: dados.ip,
            user_agent: dados.userAgent,
            created_at: agora,
            last_seen_at: agora,
            revoked_at: null,
            expires_at: dados.expiraEm,
          },
        },
        { upsert: true },
      );
    },

    async tocar(sessionId: string): Promise<void> {
      await colecao.updateOne(
        { session_id: sessionId, status: 'active' },
        { $set: { last_seen_at: new Date() } },
      );
    },

    async listarAtivas(userId: string): Promise<SessaoAtiva[]> {
      const linhas = await colecao
        .find({ user_id: userId, status: 'active', expires_at: { $gt: new Date() } })
        .sort({ last_seen_at: -1 })
        .toArray();
      return linhas.map((l) => ({
        sessionId: l.session_id,
        ip: l.ip,
        userAgent: l.user_agent,
        createdAt: l.created_at,
        lastSeenAt: l.last_seen_at,
      }));
    },

    async idsAtivasDoUsuario(userId: string): Promise<string[]> {
      const linhas = await colecao
        .find({ user_id: userId, status: 'active' }, { projection: { session_id: 1 } })
        .toArray();
      return linhas.map((l) => l.session_id);
    },

    async pertenceAoUsuario(sessionId: string, userId: string): Promise<boolean> {
      const doc = await colecao.findOne(
        { session_id: sessionId, user_id: userId },
        { projection: { _id: 1 } },
      );
      return doc !== null;
    },

    async marcarRevogada(sessionId: string): Promise<void> {
      await colecao.updateOne(
        { session_id: sessionId, status: 'active' },
        { $set: { status: 'revoked', revoked_at: new Date() } },
      );
    },
  };
}
