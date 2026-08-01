/**
 * Responsabilidade: gerar o refresh token opaco e derivar o hash com que ele é armazenado.
 * Consumido por: o repositório e o serviço de refresh token.
 * Regras:
 *  - Token = 64 bytes de `crypto.randomBytes` em base64 (88 caracteres) — o mesmo formato que
 *    o login já emite, para o contrato de `/auth/logout` seguir valendo sem mudança.
 *  - 512 bits de entropia dispensam sal/HMAC: `sha256` direto basta e é indexável. Não é
 *    senha de baixa entropia, é segredo aleatório.
 *  - Só o `sha256` hexadecimal toca o banco; o token em claro nunca é persistido.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Gera um refresh token opaco de 64 bytes em base64 (88 caracteres). */
export function gerarTokenOpaco(): string {
  return randomBytes(64).toString('base64');
}

/** SHA-256 hexadecimal do token — o que persiste no lugar do token em claro. */
export function digerirToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
