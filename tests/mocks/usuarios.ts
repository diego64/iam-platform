/**
 * Fakes em memória do módulo de usuário, para exercitar o `UserService` e o controller sem
 * PostgreSQL. Espelham a semântica do concreto: conflito de e-mail, 404 por id ausente,
 * `updated_at` que muda no update.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { StatusDeUsuario, Usuario } from '../../src/modules/users/entities/user.entity.js';
import { ErroDeUsuario } from '../../src/modules/users/errors/user-error.js';
import type {
  FiltroDeListagem,
  RepositorioDeUsuario,
} from '../../src/modules/users/repositories/user.repository.js';
import type { RevogadorDeSessoes } from '../../src/modules/users/interfaces/sessoes.port.js';
import type { AutorizadorAdmin } from '../../src/modules/users/interfaces/autorizador-admin.port.js';

export interface RepositorioDeUsuarioFake extends RepositorioDeUsuario {
  /** Semeia direto uma linha, para casos que não passam pela criação. */
  semear(usuario: Usuario): void;
}

export function criarRepositorioDeUsuarioFake(): RepositorioDeUsuarioFake {
  const porId = new Map<string, Usuario>();

  const acharPorEmail = (email: string): Usuario | undefined =>
    [...porId.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());

  return {
    semear(usuario): void {
      porId.set(usuario.id, usuario);
    },
    buscarPorEmail(email): Promise<Usuario | null> {
      return Promise.resolve(acharPorEmail(email) ?? null);
    },
    buscarPorId(id): Promise<Usuario | null> {
      return Promise.resolve(porId.get(id) ?? null);
    },
    atualizarHash(userId, novoHash): Promise<void> {
      const atual = porId.get(userId);
      if (atual !== undefined) {
        porId.set(userId, { ...atual, passwordHash: novoHash, atualizadoEm: new Date() });
      }
      return Promise.resolve();
    },
    criar({ email, passwordHash }): Promise<Usuario> {
      if (acharPorEmail(email) !== undefined) {
        return Promise.reject(new ErroDeUsuario('email-conflito'));
      }
      const agora = new Date();
      const usuario: Usuario = {
        id: randomUUID(),
        email,
        status: 'active',
        passwordHash,
        criadoEm: agora,
        atualizadoEm: agora,
      };
      porId.set(usuario.id, usuario);
      return Promise.resolve(usuario);
    },
    listar(filtro: FiltroDeListagem): Promise<Usuario[]> {
      const todos = [...porId.values()]
        .filter((u) => filtro.status === undefined || u.status === filtro.status)
        .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
      return Promise.resolve(todos.slice(filtro.offset, filtro.offset + filtro.limite));
    },
    contar(status?: StatusDeUsuario): Promise<number> {
      const total = [...porId.values()].filter(
        (u) => status === undefined || u.status === status,
      ).length;
      return Promise.resolve(total);
    },
    atualizarEmail(id, email): Promise<Usuario | null> {
      const atual = porId.get(id);
      if (atual === undefined) return Promise.resolve(null);
      const jaUsado = acharPorEmail(email);
      if (jaUsado !== undefined && jaUsado.id !== id) {
        return Promise.reject(new ErroDeUsuario('email-conflito'));
      }
      const atualizado: Usuario = { ...atual, email, atualizadoEm: new Date() };
      porId.set(id, atualizado);
      return Promise.resolve(atualizado);
    },
    definirStatus(id, status): Promise<Usuario | null> {
      const atual = porId.get(id);
      if (atual === undefined) return Promise.resolve(null);
      const atualizado: Usuario = { ...atual, status, atualizadoEm: new Date() };
      porId.set(id, atualizado);
      return Promise.resolve(atualizado);
    },
    remover(id): Promise<boolean> {
      return Promise.resolve(porId.delete(id));
    },
  };
}

export interface RevogadorDeSessoesFake extends RevogadorDeSessoes {
  readonly revogados: readonly string[];
}

export function criarRevogadorDeSessoesFake(): RevogadorDeSessoesFake {
  const revogados: string[] = [];
  return {
    revogados,
    revogarTodas(userId): Promise<void> {
      revogados.push(userId);
      return Promise.resolve();
    },
  };
}

/** Autorizador que sempre libera com o admin informado. */
export function autorizadorSempre(adminId = 'admin-1'): AutorizadorAdmin {
  return () => ({ ok: true, adminId });
}

/** Autorizador que lê `x-test-admin`: presente ⇒ libera; ausente ⇒ 401; valor 'no' ⇒ 403. */
export function autorizadorPorHeader(): AutorizadorAdmin {
  return (requisicao: FastifyRequest) => {
    const cabecalho = requisicao.headers['x-test-admin'];
    if (typeof cabecalho !== 'string' || cabecalho === '') {
      return { ok: false, motivo: 'sem-token' };
    }
    if (cabecalho === 'no') return { ok: false, motivo: 'sem-permissao' };
    return { ok: true, adminId: cabecalho };
  };
}
