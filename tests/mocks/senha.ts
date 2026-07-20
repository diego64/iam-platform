/**
 * Fakes em memória das portas da SPEC 009, para exercitar o PasswordService e as rotas
 * sem depender do concreto (002/001/006/019). Cada fake registra o que recebeu, para os
 * testes asseverarem que a porta foi chamada — não só que o fluxo retornou.
 */
import type {
  RepositorioDeUsuario,
  UsuarioParaSenha,
} from '../../src/modules/password/interfaces/usuario.port.js';
import type { RevogadorDeSessoes } from '../../src/modules/password/interfaces/sessoes.port.js';
import type { CanalDeNotificacao } from '../../src/modules/password/interfaces/notificacao.port.js';

export interface RepositorioDeUsuarioFake extends RepositorioDeUsuario {
  semear(usuario: UsuarioParaSenha): void;
  /** Último hash gravado por `atualizarHash`, para o teste conferir a troca. */
  hashAtual(userId: string): string | undefined;
}

export function criarRepositorioDeUsuarioFake(): RepositorioDeUsuarioFake {
  const porId = new Map<string, UsuarioParaSenha>();

  const buscar = (predicado: (u: UsuarioParaSenha) => boolean): UsuarioParaSenha | null =>
    [...porId.values()].find(predicado) ?? null;

  return {
    semear(usuario): void {
      porId.set(usuario.id, usuario);
    },
    hashAtual(userId): string | undefined {
      return porId.get(userId)?.passwordHash;
    },
    buscarPorEmail(email): Promise<UsuarioParaSenha | null> {
      return Promise.resolve(buscar((u) => u.email === email));
    },
    buscarPorId(id): Promise<UsuarioParaSenha | null> {
      return Promise.resolve(porId.get(id) ?? null);
    },
    atualizarHash(userId, novoHash): Promise<void> {
      const atual = porId.get(userId);
      if (atual !== undefined) porId.set(userId, { ...atual, passwordHash: novoHash });
      return Promise.resolve();
    },
  };
}

export interface RevogadorDeSessoesFake extends RevogadorDeSessoes {
  /** IDs para os quais `revogarTodas` foi chamado, em ordem. */
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

export interface CanalDeNotificacaoFake extends CanalDeNotificacao {
  /** Pares (email, token) entregues — o e2e lê o token daqui, já que não há e-mail real. */
  readonly enviados: readonly { email: string; token: string }[];
}

export function criarCanalDeNotificacaoFake(): CanalDeNotificacaoFake {
  const enviados: { email: string; token: string }[] = [];
  return {
    enviados,
    enviarReset(email, token): Promise<void> {
      enviados.push({ email, token });
      return Promise.resolve();
    },
  };
}
