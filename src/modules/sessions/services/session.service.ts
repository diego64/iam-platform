/**
 * Responsabilidade: listar as sessões do dono e encerrá-las (uma, ou todas as demais), além
 * de refletir no metadado de sessão o que o serviço de refresh faz com as famílias.
 * Consumido por: o controller das rotas de sessão e, via ganchos, o serviço de refresh.
 * Regras:
 *  - Toda operação é escopada pelo usuário autenticado. Revogar por id confirma a posse antes;
 *    sessão inexistente ou de outro dono resulta no mesmo erro (que vira 404).
 *  - Encerrar uma sessão delega ao serviço de refresh (que mata os tokens da família) e, pelo
 *    gancho de revogação, marca o metadado como revogado — um caminho único para logout, reuso
 *    e revogação manual.
 *  - "Encerrar as demais" nunca inclui a sessão atual (o `sid` do token corrente).
 *  - Nenhum Fastify nem driver aqui: repositório, revogador de família e medidor por injeção.
 */
import { ErroDeSessaoNaoEncontrada } from '../errors/session-error.js';
import { paraSessaoDTO, type SessaoDTO } from '../dto/session.dto.js';
import { medidorDeSessaoNulo, type MedidorDeSessao } from '../metrics/session.metrics.js';
import type { RepositorioDeSessoes, DadosDeInicio } from '../repositories/session.repository.js';
import type { MotivoDeRevogacaoDeFamilia } from '../../refresh-token/index.js';

/** Encerra uma família de refresh (mata os tokens); o gancho de revogação reflete na sessão. */
export type RevogadorDeFamilia = (
  familyId: string,
  motivo: MotivoDeRevogacaoDeFamilia,
) => Promise<void>;

export interface DependenciasDoSessionService {
  readonly repo: RepositorioDeSessoes;
  readonly revogarFamilia: RevogadorDeFamilia;
  readonly medidor?: MedidorDeSessao;
}

export interface SessionService {
  /** Lista as sessões ativas do usuário, marcando a atual pela `sid` do token. */
  listar(userId: string, sidAtual: string | undefined): Promise<SessaoDTO[]>;
  /** Encerra uma sessão do usuário; lança `ErroDeSessaoNaoEncontrada` se não for dele. */
  revogar(sessionId: string, userId: string): Promise<void>;
  /** Encerra todas as sessões do usuário menos a atual; devolve quantas encerrou. */
  revogarOutras(userId: string, sidAtual: string | undefined): Promise<number>;
  /** Gancho: abre o metadado de uma sessão nova (chamado pela emissão do refresh). */
  aoAbrirSessao(dados: DadosDeInicio): Promise<void>;
  /** Gancho: atualiza "visto por último" (chamado a cada rotação de refresh). */
  aoTocarSessao(sessionId: string): Promise<void>;
  /** Gancho: reflete o encerramento de uma família no metadado da sessão. */
  aoRevogarFamilia(sessionId: string, motivo: MotivoDeRevogacaoDeFamilia): Promise<void>;
}

export function criarSessionService(deps: DependenciasDoSessionService): SessionService {
  const medidor = deps.medidor ?? medidorDeSessaoNulo();

  return {
    async listar(userId, sidAtual): Promise<SessaoDTO[]> {
      const sessoes = await deps.repo.listarAtivas(userId);
      medidor.observarAtivas(sessoes.length);
      return sessoes.map((s) => paraSessaoDTO(s, sidAtual));
    },

    async revogar(sessionId, userId): Promise<void> {
      // Confirma a posse antes de tocar em qualquer coisa — a base do 404 uniforme.
      if (!(await deps.repo.pertenceAoUsuario(sessionId, userId))) {
        throw new ErroDeSessaoNaoEncontrada();
      }
      await deps.revogarFamilia(sessionId, 'sessao_unica');
    },

    async revogarOutras(userId, sidAtual): Promise<number> {
      const ids = await deps.repo.idsAtivasDoUsuario(userId);
      const outras = ids.filter((id) => id !== sidAtual);
      for (const id of outras) {
        await deps.revogarFamilia(id, 'sessao_demais');
      }
      return outras.length;
    },

    async aoAbrirSessao(dados): Promise<void> {
      await deps.repo.iniciar(dados);
    },

    async aoTocarSessao(sessionId): Promise<void> {
      await deps.repo.tocar(sessionId);
    },

    async aoRevogarFamilia(sessionId, motivo): Promise<void> {
      await deps.repo.marcarRevogada(sessionId);
      medidor.contarRevogacao(motivo);
    },
  };
}
