/**
 * Responsabilidade: orquestrar a atribuição/revogação de papéis a usuários e a leitura dos
 * papéis de um usuário.
 * Consumido por: o controller do RBAC.
 * Regras:
 *  - A restrição "só superadmin concede papéis" (RF-09) é imposta pelo guard na rota
 *    (`exigirPapel('superadmin')`), não aqui — o serviço não conhece Fastify.
 *  - Existência de usuário/papel e atomicidade da escrita são do repositório (transação).
 */
import { ErroDeRbac } from '../errors/rbac.errors.js';
import type {
  PapelResumo,
  RepositorioDeAssociacao,
} from '../repositories/assignment.repository.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';

export interface PapeisDoUsuario {
  readonly userId: string;
  readonly roles: PapelResumo[];
}

export interface DependenciasDoAssignmentService {
  readonly associacoes: RepositorioDeAssociacao;
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
}

export interface AssignmentService {
  listarPapeisDoUsuario(userId: string): Promise<PapeisDoUsuario>;
  atribuirPapeis(userId: string, roleIds: readonly string[]): Promise<void>;
  desatribuirPapel(userId: string, roleId: string): Promise<void>;
}

export function criarAssignmentService(deps: DependenciasDoAssignmentService): AssignmentService {
  const auditoria = deps.auditoria ?? registradorNulo();

  return {
    async listarPapeisDoUsuario(userId): Promise<PapeisDoUsuario> {
      if (!(await deps.associacoes.usuarioExiste(userId))) {
        throw new ErroDeRbac('usuario-nao-encontrado');
      }
      const roles = await deps.associacoes.papeisDoUsuario(userId);
      return { userId, roles };
    },

    async atribuirPapeis(userId, roleIds): Promise<void> {
      // O repositório valida usuário e papéis dentro da transação e faz rollback em falha.
      await deps.associacoes.atribuirPapeis(userId, roleIds);
      // Concessão de privilégio é o evento que uma investigação procura primeiro: quem
      // ganhou qual papel, e por ordem de quem.
      await auditoria.registrar({
        type: 'iam.role.assigned',
        actor: { id: null, type: 'user' },
        target: { id: userId, type: 'user' },
        outcome: 'success',
        reason: 'admin_action',
        metadata: { role_ids: [...roleIds] },
      });
    },

    async desatribuirPapel(userId, roleId): Promise<void> {
      await deps.associacoes.desatribuirPapel(userId, roleId);
      await auditoria.registrar({
        type: 'iam.role.revoked',
        actor: { id: null, type: 'user' },
        target: { id: userId, type: 'user' },
        outcome: 'success',
        reason: 'admin_action',
        metadata: { role_ids: [roleId] },
      });
    },
  };
}
