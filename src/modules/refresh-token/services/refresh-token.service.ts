/**
 * Responsabilidade: emitir, rotacionar e revogar refresh tokens opacos com detecção de reuso.
 * Consumido por: o login/logout (via `PortaDeRefreshToken`) e a rota `POST /auth/refresh`
 * (via `rotacionar`).
 * Regras:
 *  - Implementa a `PortaDeRefreshToken` (o concreto que substitui o stub em memória) e
 *    acrescenta `rotacionar`, que a porta não precisa conhecer.
 *  - Rotação de uso único: cada token vira `rotated` na primeira troca; reapresentá-lo
 *    (fora da janela de graça) derruba a família inteira. Fail closed: erro de I/O no
 *    lookup/rotação recusa o token (401), nunca deixa passar.
 *  - Nenhum Fastify nem driver aqui: repositório, leitura de usuário e emissor de token
 *    entram por injeção. O log fica na borda HTTP (controller), com o `trace_id`.
 */
import { gerarTokenOpaco, digerirToken } from './opaque-token.js';
import { ErroDeRefreshInvalido } from '../errors/refresh-token-error.js';
import { medidorDeRefreshNulo, type MedidorDeRefresh } from '../metrics/refresh.metrics.js';
import type { RepositorioDeRefreshToken } from '../repositories/refresh-token.repository.js';
import type { RepositorioDeAutenticacao } from '../../auth/repositories/auth-user.repository.js';
import type { TokenService } from '../../auth/services/token.service.js';
import type { PortaDeRefreshToken } from '../../auth/interfaces/refresh-token.port.js';
import type { ParDeTokens } from '../../auth/types/auth.types.js';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';

export interface DependenciasDoRefreshTokenService {
  readonly repo: RepositorioDeRefreshToken;
  /** Leitura do usuário no refresh — status, papéis e permissões atuais (não os do login). */
  readonly usuarios: Pick<
    RepositorioDeAutenticacao,
    'buscarPorId' | 'papeisDoUsuario' | 'permissoesEfetivas'
  >;
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
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
}

export interface RefreshTokenService extends PortaDeRefreshToken {
  /** Troca um refresh token válido por um novo par (access + refresh). Lança em qualquer falha. */
  rotacionar(refreshToken: string): Promise<ParDeTokens>;
}

export function criarRefreshTokenService(
  deps: DependenciasDoRefreshTokenService,
): RefreshTokenService {
  const medidor = deps.medidor ?? medidorDeRefreshNulo();
  const auditoria = deps.auditoria ?? registradorNulo();
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

  return {
    async emitir(userId: string): Promise<string> {
      const familyId = uuidv7();
      const absoluteExpiresAt = new Date(Date.now() + deps.ttlAbsolutoMs);
      return persistirNovo(userId, familyId, absoluteExpiresAt);
    },

    async revogar(refreshToken: string): Promise<void> {
      // Logout: derruba a sessão inteira, não só o token apresentado. Token desconhecido é
      // no-op idempotente.
      const doc = await deps.repo.buscarPorHash(digerirToken(refreshToken));
      if (doc === null) return;
      await deps.repo.revogarFamilia(doc.familyId);
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
        await deps.repo.revogarFamilia(doc.familyId);
        medidor.contarReuso();
        // Token consumido reapresentado fora da janela de corrida: ou vazou, ou foi
        // roubado. A família inteira já caiu; o evento é o que permite investigar depois.
        await auditoria.registrar({
          type: 'iam.token.reuse_detected',
          actor: { id: doc.userId, type: 'user' },
          target: { id: doc.familyId, type: 'session' },
          outcome: 'failure',
          reason: 'token_reused',
        });
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
        await deps.repo.revogarFamilia(doc.familyId);
        medidor.contarFalha('usuario_bloqueado');
        throw new ErroDeRefreshInvalido('usuario_bloqueado');
      }

      const [roles, permissions] = await Promise.all([
        deps.usuarios.papeisDoUsuario(doc.userId),
        deps.usuarios.permissoesEfetivas(doc.userId),
      ]);
      const emitido = await deps.tokenService.emitir({
        sub: doc.userId,
        roles,
        permissions,
        scope,
      });
      const novoRefresh = await persistirNovo(doc.userId, doc.familyId, doc.absoluteExpiresAt);

      medidor.contarRotacao();
      medidor.observarDuracao((Date.now() - inicio) / 1000);
      await auditoria.registrar({
        type: 'iam.token.refreshed',
        actor: { id: doc.userId, type: 'user' },
        target: { id: doc.familyId, type: 'session' },
        outcome: 'success',
      });
      return {
        accessToken: emitido.token,
        refreshToken: novoRefresh,
        expiraEmSegundos: emitido.ttlSegundos,
      };
    },
  };
}
