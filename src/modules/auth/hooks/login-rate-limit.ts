/**
 * Responsabilidade: limite de taxa do login.
 * Consumido por: `routes/` (via `config.rateLimit`) e o registro do `@fastify/rate-limit`.
 * Regras:
 *  - Chave por IP: é o que o hook `onRequest` do rate-limit enxerga, antes de o corpo ser
 *    lido. Um segundo limite por conta dependeria do e-mail do corpo, que só existe depois
 *    desse hook — entra como camada adicional junto com o rate limiting dedicado que virá.
 *  - Excedido o teto, o plugin responde 429 com `Retry-After`, em problem+json.
 */

/** Configuração de rate limit por rota, no formato que o @fastify/rate-limit espera. */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

/** Teto apertado: login é o alvo clássico de brute force. */
export const LIMITE_LOGIN: ConfigDeRota = { max: 5, timeWindow: '1 minute' };
