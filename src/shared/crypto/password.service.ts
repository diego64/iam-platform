/**
 * Responsabilidade: hash e verificação de senhas com scrypt nativo.
 * Regras:
 *  - Formato de armazenamento: scrypt$N$r$p$saltB64$hashB64
 *  - Salt: crypto.randomBytes(32) por usuário; hash de 64 bytes
 *  - Verificação SEMPRE com crypto.timingSafeEqual
 *  - Exportar HASH_FANTASMA para equalizar timing quando o usuário não existe (SPEC 001)
 *  - Parâmetros vindos de env (SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION)
 */
export interface ServicoDeSenha {
  gerarHash(senha: string): Promise<string>;
  verificar(senha: string, hashArmazenado: string): Promise<boolean>;
}
