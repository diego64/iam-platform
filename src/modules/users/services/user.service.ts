/**
 * Responsabilidade: as regras de negócio do ciclo de vida do usuário — criar, obter,
 * listar, trocar e-mail, bloquear/desbloquear e remover.
 * Regras:
 *  - Não conhece Fastify nem drivers: recebe repositório, serviço de senha e revogador de
 *    sessões por injeção.
 *  - Sinaliza falha lançando `ErroDeUsuario` com código genérico; o controller mapeia para
 *    RFC 7807. Nenhuma mensagem ecoa a senha.
 *  - Bloqueio e remoção SEMPRE revogam as sessões do alvo — um usuário barrado não pode
 *    seguir com Access Token válido.
 */
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import { avaliarPolitica, mensagemDeRejeicao } from '../../password/validators/politica.js';
import type { Usuario } from '../entities/user.entity.js';
import { ErroDeUsuario } from '../errors/user-error.js';
import type { RevogadorDeSessoes } from '../interfaces/sessoes.port.js';
import type { FiltroDeListagem, RepositorioDeUsuario } from '../repositories/user.repository.js';

export interface DependenciasDeUsuario {
  readonly repositorio: RepositorioDeUsuario;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly sessoes: RevogadorDeSessoes;
}

export interface UserService {
  criar(entrada: { email: string; senha: string }): Promise<Usuario>;
  obter(id: string): Promise<Usuario>;
  listar(filtro: FiltroDeListagem): Promise<{ items: Usuario[]; total: number }>;
  atualizarEmail(id: string, email: string): Promise<Usuario>;
  bloquear(id: string): Promise<Usuario>;
  desbloquear(id: string): Promise<Usuario>;
  remover(id: string): Promise<void>;
}

export function criarUserService(deps: DependenciasDeUsuario): UserService {
  const { repositorio, servicoDeSenha, sessoes } = deps;

  /**
   * Revalida a política no domínio (defesa em profundidade). O Zod da borda já reprova a
   * maioria; aqui entra o contexto do e-mail ("senha não pode conter o e-mail") e a
   * garantia para o caminho interno (bootstrap) que não passa por rota HTTP.
   */
  function exigirPolitica(senha: string, email: string): void {
    const resultado = avaliarPolitica(senha, { email });
    if (!resultado.ok) throw new ErroDeUsuario('politica', mensagemDeRejeicao(resultado.motivo));
  }

  return {
    async criar({ email, senha }): Promise<Usuario> {
      exigirPolitica(senha, email);
      const passwordHash = await servicoDeSenha.gerarHash(senha);
      // Conflito de e-mail vira `ErroDeUsuario('email-conflito')` dentro do repositório.
      return repositorio.criar({ email, passwordHash });
    },

    async obter(id): Promise<Usuario> {
      const usuario = await repositorio.buscarPorId(id);
      if (usuario === null) throw new ErroDeUsuario('nao-encontrado');
      return usuario;
    },

    async listar(filtro): Promise<{ items: Usuario[]; total: number }> {
      const [items, total] = await Promise.all([
        repositorio.listar(filtro),
        repositorio.contar(filtro.status),
      ]);
      return { items, total };
    },

    async atualizarEmail(id, email): Promise<Usuario> {
      const atualizado = await repositorio.atualizarEmail(id, email);
      if (atualizado === null) throw new ErroDeUsuario('nao-encontrado');
      return atualizado;
    },

    async bloquear(id): Promise<Usuario> {
      const usuario = await repositorio.definirStatus(id, 'blocked');
      if (usuario === null) throw new ErroDeUsuario('nao-encontrado');
      // Sempre revoga — inclusive num segundo block idempotente: garantir "sem sessão viva"
      // é barato e fecha a corrida em que uma sessão nasceu entre o primeiro block e este.
      await sessoes.revogarTodas(id);
      return usuario;
    },

    async desbloquear(id): Promise<Usuario> {
      const usuario = await repositorio.definirStatus(id, 'active');
      if (usuario === null) throw new ErroDeUsuario('nao-encontrado');
      return usuario;
    },

    async remover(id): Promise<void> {
      // Revoga antes de apagar: some a linha, mas nenhum token do usuário sobrevive à
      // remoção. O cascade da FK cuida de `user_roles`/`password_history`.
      await sessoes.revogarTodas(id);
      const removido = await repositorio.remover(id);
      if (!removido) throw new ErroDeUsuario('nao-encontrado');
    },
  };
}
