/**
 * Porta de acesso ao usuário, do ponto de vista de quem gerencia senha.
 *
 * O gerenciamento de senha é implementado antes do CRUD de usuário: define esta interface
 * e roda contra um fake; o concreto sobre a tabela `users` chega com o módulo de usuário.
 * Expõe só o que o domínio de senha precisa — não é o repositório de usuário inteiro.
 */
export interface UsuarioParaSenha {
  readonly id: string;
  readonly email: string;
  readonly status: 'active' | 'blocked';
  /** Hash corrente no formato `scrypt$...`. */
  readonly passwordHash: string;
}

export interface RepositorioDeUsuario {
  buscarPorEmail(email: string): Promise<UsuarioParaSenha | null>;
  buscarPorId(id: string): Promise<UsuarioParaSenha | null>;
  /** Troca o hash corrente do usuário. A gravação em `password_history` é do serviço. */
  atualizarHash(userId: string, novoHash: string): Promise<void>;
}
