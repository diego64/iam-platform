/**
 * Responsabilidade: limites de taxa das rotas de senha.
 * Consumido por: `routes/` (via `config.rateLimit` de cada rota) e o registro do
 * `@fastify/rate-limit` no bootstrap.
 * Regras:
 *  - Chave por IP: é o que o hook `onRequest` do rate-limit enxerga, antes de o corpo ser
 *    lido e antes de a autenticação rodar. Um segundo limite por conta/e-mail dependeria
 *    do corpo (o e-mail do forgot) ou do usuário autenticado (o id do change), que só
 *    existem depois desse hook — entra como camada adicional quando houver um autenticador
 *    que popule o usuário já no onRequest.
 *  - Excedido o limite, o plugin responde 429 com cabeçalho `Retry-After`, formatado como
 *    problem+json pelo error handler global.
 */

/** Configuração de rate limit por rota, no formato que o @fastify/rate-limit espera. */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

/** Troca e reset partem de credencial (senha atual ou token), então toleram mais tentativas. */
export const LIMITE_CHANGE: ConfigDeRota = { max: 5, timeWindow: '1 minute' };
export const LIMITE_RESET: ConfigDeRota = { max: 10, timeWindow: '1 minute' };
/** Pedir recuperação é o alvo clássico de abuso — spam de e-mail e sondagem de contas —
 * então recebe o teto mais apertado. */
export const LIMITE_FORGOT: ConfigDeRota = { max: 5, timeWindow: '1 minute' };
