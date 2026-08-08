/**
 * Responsabilidade: limite de taxa do endpoint de token.
 * Consumido por: `routes/` (via `config.rateLimit`).
 * Regras:
 *  - Chave por IP: é o que o hook `onRequest` enxerga antes de o corpo ser lido, e o
 *    `client_id` pode vir tanto do header quanto do formulário. O limite por cliente é da
 *    SPEC 016, que tem contadores próprios.
 *  - Teto folgado o bastante para um serviço que renova token legitimamente, apertado o
 *    bastante para tornar caro varrer segredo de cliente.
 */

/** Configuração de rate limit por rota, no formato que o @fastify/rate-limit espera. */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

export const LIMITE_TOKEN: ConfigDeRota = { max: 30, timeWindow: '1 minute' };
