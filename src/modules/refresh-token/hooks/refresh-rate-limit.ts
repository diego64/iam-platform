/**
 * Responsabilidade: limite de taxa da rotação de refresh.
 * Consumido por: `routes/` (via `config.rateLimit`) e o registro do `@fastify/rate-limit`.
 * Regras:
 *  - Chave por IP: é o que o hook `onRequest` enxerga antes de ler o corpo. O reuso de um
 *    token roubado já é barrado pela detecção de reuso; o rate limit aqui contém força bruta
 *    de tokens.
 *  - Teto mais folgado que o do login: refresh é chamada legítima recorrente do cliente.
 */

/** Configuração de rate limit por rota, no formato que o @fastify/rate-limit espera. */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

export const LIMITE_REFRESH: ConfigDeRota = { max: 30, timeWindow: '1 minute' };
