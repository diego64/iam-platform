/**
 * Porta do histórico de hashes de senha, usada para bloquear o reuso das últimas N senhas.
 *
 * Concreto sobre a tabela `password_history` (migração 0003). Definida como porta para o
 * PasswordService ser testável com um fake em memória, sem PG.
 */
export interface RepositorioDeHistoricoDeSenha {
  /** Os últimos `n` hashes do usuário, mais recentes primeiro. */
  ultimosHashes(userId: string, n: number): Promise<string[]>;
  /** Registra um hash recém-definido no histórico. */
  registrar(userId: string, hash: string): Promise<void>;
}
