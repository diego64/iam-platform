/**
 * Responsabilidade: emitir, rotacionar e revogar refresh tokens opacos com detecção de reuso,
 * e ser o ponto único por onde o ciclo de vida de uma sessão passa.
 * Consumido por: o login/logout (via `PortaDeRefreshToken`) e a rota de rotação (via `rotacionar`).
 * Regras:
 *  - Implementa a `PortaDeRefreshToken` (o concreto que substitui o stub em memória) e
 *    acrescenta `rotacionar` e `revogarFamilia`.
 *  - Rotação de uso único: cada token vira `rotated` na primeira troca; reapresentá-lo
 *    (fora da janela de graça) derruba a família inteira. Fail closed: erro de I/O no
 *    lookup/rotação recusa o token, nunca deixa passar.
 *  - A família é a sessão. Abrir, tocar (a cada rotação) e encerrar uma família disparam
 *    callbacks opcionais — é assim que a listagem de sessões reflete o que acontece aqui sem
 *    este módulo conhecer a coleção de sessões. Os callbacks são best-effort: falhar em
 *    atualizar o metadado da sessão não pode derrubar a autenticação.
 *  - Nenhum Fastify nem driver aqui: repositório, leitura de usuário, emissor de token e os
 *    callbacks de sessão entram por injeção.
 */
import { gerarTokenOpaco, digerirToken } from './opaque-token.js';
import { ErroDeRefreshInvalido } from '../errors/refresh-token-error.js';
import { medidorDeRefreshNulo, type MedidorDeRefresh } from '../metrics/refresh.metrics.js';
import type { RepositorioDeRefreshToken } from '../repositories/refresh-token.repository.js';
import type { RepositorioDeAutenticacao } from '../../auth/repositories/auth-user.repository.js';
import type { TokenService } from '../../auth/services/token.service.js';
import type {
  ContextoDeSessao,
  PortaDeRefreshToken,
  RefreshEmitido,
} from '../../auth/interfaces/refresh-token.port.js';
import type { ParDeTokens } from '../../auth/types/auth.types.js';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';

/** Por que uma família (sessão) foi encerrada — usado para atribuir a métrica de revogação. */
export type MotivoDeRevogacaoDeFamilia =
  'logout' | 'reuso' | 'bloqueio' | 'sessao_unica' | 'sessao_demais';

/** Dados que abrem o registro de metadados de uma sessão nova. */
export interface DadosDeAberturaDeSessao {
  readonly sessionId: string;
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Teto absoluto da família — quando o registro da sessão pode expirar sozinho. */
  readonly expiraEm: Date;
}

export interface DependenciasDoRefreshTokenService {
  readonly repo: RepositorioDeRefreshToken;
  /** Leitura do usuário no refresh — status e papéis atuais (não os do login). */
  readonly usuarios: Pick<RepositorioDeAutenticacao, 'buscarPorId' | 'papeisDoUsuario'>;
  readonly tokenService: TokenService;
  /** Validade deslizante (idle) por token, renovada a cada rotação. */
  readonly ttlIdleMs: number;
  /** Teto absoluto por família; a rotação nunca o estende. */
  readonly ttlAbsolutoMs: number;
  /** Janela em que uma rotação concorrente não é confundida com reuso. */
  readonly graceMs: number;
  /** Scope padrão dos tokens reemitidos (igual ao do login por senha). */
  readonly scopePadrao?: string;
  readonly medidor?: MedidorDeRefresh;
  /** Abre o registro de metadados de uma sessão nova (best-effort). */
  readonly aoAbrirSessao?: (dados: DadosDeAberturaDeSessao) => Promise<void>;
  /** Marca "visto por último" da sessão a cada rotação (best-effort). */
  readonly aoTocarSessao?: (sessionId: string) => Promise<void>;
  /** Reflete o encerramento da família no registro da sessão (best-effort). */
  readonly aoRevogarFamilia?: (
    sessionId: string,
    motivo: MotivoDeRevogacaoDeFamilia,
  ) => Promise<void>;
}

export interface RefreshTokenService extends PortaDeRefreshToken {
  /** Troca um refresh token válido por um novo par (access + refresh). Lança em qualquer falha. */
  rotacionar(refreshToken: string): Promise<ParDeTokens>;
  /** Encerra uma família inteira (todos os tokens ativos) e reflete na sessão. */
  revogarFamilia(familyId: string, motivo: MotivoDeRevogacaoDeFamilia): Promise<void>;
}

export function criarRefreshTokenService(
  deps: DependenciasDoRefreshTokenService,
): RefreshTokenService {
  const medidor = deps.medidor ?? medidorDeRefreshNulo();
  const scope = deps.scopePadrao ?? '';

  /** Persiste um token novo numa família, com validade deslizante e teto absoluto dados. */
  async function persistirNovo(
    userId: string,
    familyId: string,
    absoluteExpiresAt: Date,
  ): Promise<string> {
    const token = gerarTokenOpaco();
    await deps.repo.registrar({
      tokenHash: digerirToken(token),
      familyId,
      userId,
      idleExpiresAt: new Date(Date.now() + deps.ttlIdleMs),
      absoluteExpiresAt,
    });
    return token;
  }

  /** Mata a família nos tokens e, em seguida, reflete na sessão (sem deixar o reflexo quebrar). */
  async function encerrarFamilia(
    familyId: string,
    motivo: MotivoDeRevogacaoDeFamilia,
  ): Promise<void> {
    await deps.repo.revogarFamilia(familyId);
    try {
      await deps.aoRevogarFamilia?.(familyId, motivo);
    } catch {
      /* reflexo na sessão é best-effort; os tokens já foram revogados */
    }
  }

  return {
    async emitir(userId: string, contexto: ContextoDeSessao): Promise<RefreshEmitido> {
      const familyId = uuidv7();
      const absoluteExpiresAt = new Date(Date.now() + deps.ttlAbsolutoMs);
      const token = await persistirNovo(userId, familyId, absoluteExpiresAt);
      try {
        await deps.aoAbrirSessao?.({
          sessionId: familyId,
          userId,
          ip: contexto.ip,
          userAgent: contexto.userAgent,
          expiraEm: absoluteExpiresAt,
        });
      } catch {
        /* abertura de metadado é best-effort; a autenticação não depende dela */
      }
      return { token, sessionId: familyId };
    },

    async revogar(refreshToken: string): Promise<void> {
      // Logout: derruba a sessão inteira, não só o token apresentado. Token desconhecido é
      // no-op idempotente.
      const doc = await deps.repo.buscarPorHash(digerirToken(refreshToken));
      if (doc === null) return;
      await encerrarFamilia(doc.familyId, 'logout');
    },

    async revogarFamilia(familyId: string, motivo: MotivoDeRevogacaoDeFamilia): Promise<void> {
      await encerrarFamilia(familyId, motivo);
    },

    async rotacionar(refreshToken: string): Promise<ParDeTokens> {
      const inicio = Date.now();
      const hash = digerirToken(refreshToken);
      const agora = new Date();

      let doc;
      try {
        doc = await deps.repo.buscarPorHash(hash);
      } catch {
        // Fail closed: indisponibilidade do Mongo recusa o token, nunca deixa passar.
        throw new ErroDeRefreshInvalido('indisponivel');
      }

      if (doc === null) {
        medidor.contarFalha('nao_encontrado');
        throw new ErroDeRefreshInvalido('nao_encontrado');
      }

      if (doc.status !== 'active') {
        // Token já consumido. Rotação recente = corrida legítima (benigna); o resto é reuso.
        const rotacionadoHaPouco =
          doc.status === 'rotated' &&
          doc.rotatedAt !== null &&
          agora.getTime() - doc.rotatedAt.getTime() < deps.graceMs;
        if (rotacionadoHaPouco) {
          throw new ErroDeRefreshInvalido('corrida');
        }
        await encerrarFamilia(doc.familyId, 'reuso');
        medidor.contarReuso();
        throw new ErroDeRefreshInvalido('reuso');
      }

      if (agora.getTime() >= doc.idleExpiresAt.getTime()) {
        medidor.contarFalha('idle_expirado');
        throw new ErroDeRefreshInvalido('idle_expirado');
      }
      if (agora.getTime() >= doc.absoluteExpiresAt.getTime()) {
        medidor.contarFalha('absoluto_expirado');
        throw new ErroDeRefreshInvalido('absoluto_expirado');
      }

      let anterior;
      try {
        anterior = await deps.repo.rotacionarAtomico(hash, agora);
      } catch {
        throw new ErroDeRefreshInvalido('indisponivel');
      }
      if (anterior === null) {
        // Estava active no read, mas outro pedido rotacionou antes deste: corrida legítima.
        throw new ErroDeRefreshInvalido('corrida');
      }

      // Reavalia o usuário: bloqueio ou mudança de papel desde o login refletem agora.
      const usuario = await deps.usuarios.buscarPorId(doc.userId);
      if (usuario === null || usuario.status !== 'active') {
        await encerrarFamilia(doc.familyId, 'bloqueio');
        medidor.contarFalha('usuario_bloqueado');
        throw new ErroDeRefreshInvalido('usuario_bloqueado');
      }

      const roles = await deps.usuarios.papeisDoUsuario(doc.userId);
      const emitido = await deps.tokenService.emitir({
        sub: doc.userId,
        roles,
        scope,
        sid: doc.familyId,
      });
      const novoRefresh = await persistirNovo(doc.userId, doc.familyId, doc.absoluteExpiresAt);

      try {
        await deps.aoTocarSessao?.(doc.familyId);
      } catch {
        /* atualizar "visto por último" é best-effort */
      }

      medidor.contarRotacao();
      medidor.observarDuracao((Date.now() - inicio) / 1000);
      return {
        accessToken: emitido.token,
        refreshToken: novoRefresh,
        expiraEmSegundos: emitido.ttlSegundos,
      };
    },
  };
}
