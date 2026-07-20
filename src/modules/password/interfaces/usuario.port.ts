/**
 * Porta de acesso ao usuário, do ponto de vista de quem gerencia senha.
 *
 * A 009 precede a 002 no roadmap: define esta interface e roda contra um fake; a 002
 * injeta o concreto sobre a tabela `users`. Expõe só o que o domínio de senha precisa —
 * não é o repositório de usuário inteiro.
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
