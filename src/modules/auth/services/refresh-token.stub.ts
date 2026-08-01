/**
 * Responsabilidade: refresh token opaco mínimo enquanto a SPEC 005 não existe — gera 64
 * bytes aleatórios em base64 (88 caracteres) e não persiste nada.
 * Regras: a revogação é no-op aqui; a rotação e o armazenamento com TTL no Mongo são da
 * SPEC 005, que substitui este stub sem mudar o contrato.
 */
import { randomBytes } from 'node:crypto';
import type { PortaDeRefreshToken } from '../interfaces/refresh-token.port.js';

export function criarRefreshTokenStub(): PortaDeRefreshToken {
  return {
    emitir: () => Promise.resolve(randomBytes(64).toString('base64')),
    revogar: () => Promise.resolve(),
  };
}
