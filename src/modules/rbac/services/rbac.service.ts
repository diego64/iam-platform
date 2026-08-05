/**
 * Responsabilidade: orquestrar o CRUD de papéis e permissões e as associações papel↔permissão.
 * Consumido por: o controller do RBAC.
 * Regras:
 *  - Papel/permissão `is_system` (seed da 0004) não pode ser renomeado nem removido:
 *    `ErroDeRbac('papel-imutavel' | 'permissao-imutavel')`.
 *  - Nenhum banco nem Fastify aqui: os repositórios entram por injeção.
 *  - A atomicidade da associação é do repositório (transação); o serviço só delega.
 */
import type { Papel, Permissao } from '../entities/rbac.entity.js';
import { ErroDeRbac } from '../errors/rbac.errors.js';
import type { RepositorioDePapel } from '../repositories/role.repository.js';
import type { RepositorioDePermissao } from '../repositories/permission.repository.js';
import type { RepositorioDeAssociacao } from '../repositories/assignment.repository.js';
import {
  registradorNulo,
  type RegistradorDeAuditoria,
} from '../../audit/interfaces/audit-recorder.js';

export interface PapelComPermissoes extends Papel {
  readonly permissions: string[];
}

export interface Pagina<T> {
  readonly items: T[];
  readonly total: number;
}

export interface PatchDePapel {
  readonly name?: string;
  readonly description?: string | null;
}

export interface DependenciasDoRbacService {
  readonly papeis: RepositorioDePapel;
  readonly permissoes: RepositorioDePermissao;
  readonly associacoes: RepositorioDeAssociacao;
  /** Trilha de auditoria. Ausente, o serviço roda sem registrar — o padrão nos testes. */
  readonly auditoria?: RegistradorDeAuditoria;
}

export interface RbacService {
  criarPapel(entrada: { name: string; description?: string }): Promise<Papel>;
  listarPapeis(filtro: { limite: number; offset: number }): Promise<Pagina<Papel>>;
  obterPapel(id: string): Promise<PapelComPermissoes>;
  atualizarPapel(id: string, patch: PatchDePapel): Promise<Papel>;
  removerPapel(id: string): Promise<void>;
  associarPermissoes(roleId: string, permissionIds: readonly string[]): Promise<void>;
  desassociarPermissao(roleId: string, permissionId: string): Promise<void>;
  criarPermissao(entrada: { name: string; description?: string }): Promise<Permissao>;
  listarPermissoes(filtro: { limite: number; offset: number }): Promise<Pagina<Permissao>>;
  removerPermissao(id: string): Promise<void>;
}

export function criarRbacService(deps: DependenciasDoRbacService): RbacService {
  const auditoria = deps.auditoria ?? registradorNulo();

  return {
    async criarPapel(entrada): Promise<Papel> {
      return deps.papeis.criar({ name: entrada.name, description: entrada.description ?? null });
    },

    async listarPapeis(filtro): Promise<Pagina<Papel>> {
      const [items, total] = await Promise.all([deps.papeis.listar(filtro), deps.papeis.contar()]);
      return { items, total };
    },

    async obterPapel(id): Promise<PapelComPermissoes> {
      const papel = await deps.papeis.buscarPorId(id);
      if (papel === null) throw new ErroDeRbac('papel-nao-encontrado');
      const permissions = await deps.associacoes.permissoesDoPapel(id);
      return { ...papel, permissions };
    },

    async atualizarPapel(id, patch): Promise<Papel> {
      const papel = await deps.papeis.buscarPorId(id);
      if (papel === null) throw new ErroDeRbac('papel-nao-encontrado');
      if (papel.isSystem) throw new ErroDeRbac('papel-imutavel');
      const atualizado = await deps.papeis.atualizar(id, {
        name: patch.name ?? papel.name,
        description: patch.description === undefined ? papel.description : patch.description,
      });
      // Já confirmamos a existência acima; o null aqui seria uma corrida improvável.
      if (atualizado === null) throw new ErroDeRbac('papel-nao-encontrado');
      return atualizado;
    },

    async removerPapel(id): Promise<void> {
      const papel = await deps.papeis.buscarPorId(id);
      if (papel === null) throw new ErroDeRbac('papel-nao-encontrado');
      if (papel.isSystem) throw new ErroDeRbac('papel-imutavel');
      await deps.papeis.remover(id);
    },

    async associarPermissoes(roleId, permissionIds): Promise<void> {
      await deps.associacoes.associarPermissoes(roleId, permissionIds);
      // Acrescentar permissão a um papel amplia o privilégio de todo mundo que já o tem —
      // o alvo do evento é o papel, e o efeito é coletivo.
      await auditoria.registrar({
        type: 'iam.role.permission_granted',
        actor: { id: null, type: 'user' },
        target: { id: roleId, type: 'role' },
        outcome: 'success',
        reason: 'admin_action',
        metadata: { permission_ids: [...permissionIds] },
      });
    },

    async desassociarPermissao(roleId, permissionId): Promise<void> {
      await deps.associacoes.desassociarPermissao(roleId, permissionId);
    },

    async criarPermissao(entrada): Promise<Permissao> {
      return deps.permissoes.criar({
        name: entrada.name,
        description: entrada.description ?? null,
      });
    },

    async listarPermissoes(filtro): Promise<Pagina<Permissao>> {
      const [items, total] = await Promise.all([
        deps.permissoes.listar(filtro),
        deps.permissoes.contar(),
      ]);
      return { items, total };
    },

    async removerPermissao(id): Promise<void> {
      const permissao = await deps.permissoes.buscarPorId(id);
      if (permissao === null) throw new ErroDeRbac('permissao-nao-encontrada');
      if (permissao.isSystem) throw new ErroDeRbac('permissao-imutavel');
      await deps.permissoes.remover(id);
    },
  };
}
