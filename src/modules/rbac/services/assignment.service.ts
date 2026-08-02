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

export interface PapeisDoUsuario {
  readonly userId: string;
  readonly roles: PapelResumo[];
}

export interface DependenciasDoAssignmentService {
  readonly associacoes: RepositorioDeAssociacao;
}

export interface AssignmentService {
  listarPapeisDoUsuario(userId: string): Promise<PapeisDoUsuario>;
  atribuirPapeis(userId: string, roleIds: readonly string[]): Promise<void>;
  desatribuirPapel(userId: string, roleId: string): Promise<void>;
}

export function criarAssignmentService(deps: DependenciasDoAssignmentService): AssignmentService {
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
    },

    async desatribuirPapel(userId, roleId): Promise<void> {
      await deps.associacoes.desatribuirPapel(userId, roleId);
    },
  };
}
