/**
 * Responsabilidade: ver e encerrar as sessões de **outra** pessoa.
 * Consumido por: o controller do painel administrativo.
 * Regras:
 *  - A revogação é delegada, não reimplementada. Encerrar uma sessão tem mais de um efeito
 *    (marcar a sessão, derrubar a família de refresh); um segundo caminho para isso
 *    envelheceria diferente do primeiro e um dos dois deixaria uma ponta viva.
 *  - O administrador não encerra a própria sessão por aqui. O caminho existe — é a rota de
 *    sessões do próprio usuário —, e recusar aqui evita o autoencerramento acidental no meio
 *    de uma operação administrativa.
 *  - Revogar sessão já revogada não é erro: a intenção do administrador era "que ela não
 *    exista", e ela não existe.
 *  - Toda revogação é registrada na trilha com o ator, o alvo e o alcance.
 */
import { ErroDeAdmin } from '../errors/admin.errors.js';
import type { RegistradorDeAuditoria } from '../../audit/interfaces/audit-recorder.js';
import { registradorNulo } from '../../audit/interfaces/audit-recorder.js';
import type {
  LeitorDeSessoes,
  LeitorDeUsuarios,
  RevogadorDeSessoesDeTerceiro,
  SessaoDeUsuario,
} from '../interfaces/portas.js';

export interface DependenciasDeSessoesAdministrativas {
  readonly usuarios: LeitorDeUsuarios;
  readonly sessoes: LeitorDeSessoes;
  readonly revogador: RevogadorDeSessoesDeTerceiro;
  readonly auditoria?: RegistradorDeAuditoria;
  readonly medidor?: { contarRevogacao(escopo: 'uma' | 'todas'): void };
}

export interface AdminSessionsService {
  listar(userId: string): Promise<SessaoDeUsuario[]>;
  revogarUma(atorId: string, userId: string, sessionId: string): Promise<void>;
  revogarTodas(atorId: string, userId: string): Promise<number>;
}

export function criarAdminSessionsService(
  deps: DependenciasDeSessoesAdministrativas,
): AdminSessionsService {
  const auditoria = deps.auditoria ?? registradorNulo();

  async function exigirUsuario(userId: string): Promise<void> {
    if ((await deps.usuarios.buscarPorId(userId)) === null) {
      throw new ErroDeAdmin('usuario-nao-encontrado');
    }
  }

  function recusarSeForOAtor(atorId: string, userId: string): void {
    if (atorId === userId) throw new ErroDeAdmin('sessao-propria');
  }

  async function registrar(
    atorId: string,
    userId: string,
    escopo: string,
    quantidade: number,
  ): Promise<void> {
    await auditoria.registrar({
      type: 'iam.session.revoked',
      actor: { id: atorId, type: 'user' },
      target: { id: userId, type: 'user' },
      outcome: 'success',
      reason: 'admin_action',
      metadata: { escopo, revogadas: quantidade },
    });
  }

  return {
    async listar(userId: string): Promise<SessaoDeUsuario[]> {
      await exigirUsuario(userId);
      return deps.sessoes.listarDoUsuario(userId);
    },

    async revogarUma(atorId: string, userId: string, sessionId: string): Promise<void> {
      recusarSeForOAtor(atorId, userId);
      await exigirUsuario(userId);

      // `false` cobre os dois casos que não podem virar revogação: a sessão não existe, ou
      // existe e é de outra pessoa. Distinguir os dois na resposta contaria ao administrador
      // de quem é a sessão que ele não pode tocar.
      if (!(await deps.revogador.revogarUma(userId, sessionId))) {
        throw new ErroDeAdmin('sessao-nao-encontrada');
      }

      deps.medidor?.contarRevogacao('uma');
      await registrar(atorId, userId, sessionId, 1);
    },

    async revogarTodas(atorId: string, userId: string): Promise<number> {
      recusarSeForOAtor(atorId, userId);
      await exigirUsuario(userId);

      const revogadas = await deps.revogador.revogarTodas(userId);
      deps.medidor?.contarRevogacao('todas');
      await registrar(atorId, userId, 'todas', revogadas);
      return revogadas;
    },
  };
}
