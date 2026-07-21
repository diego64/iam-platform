/**
 * Responsabilidade: limites de taxa das rotas de escrita de usuário.
 * Consumido por: `routes/` (via `config.rateLimit`) e o registro do `@fastify/rate-limit`.
 * Regras:
 *  - Chave por IP: é o que o hook `onRequest` do rate-limit enxerga, antes da autenticação.
 *    Um segundo limite por conta admin depende do ator autenticado, que só existe depois do
 *    autorizador — entra como camada adicional quando o preHandler de auth (001) popular o
 *    usuário no onRequest.
 *  - Excedido, o plugin responde 429 com `Retry-After`, formatado como problem+json.
 *  - Leitura (`GET`) não é limitada aqui: é idempotente e barata, e o rate limit global do
 *    server.ts já a cobre.
 */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

/** Criar usuário inclui um `scrypt`: mais caro, teto mais apertado. */
export const LIMITE_CRIACAO: ConfigDeRota = { max: 10, timeWindow: '1 minute' };
/** Demais escritas administrativas (patch, block, unblock, delete): baratas, teto maior. */
export const LIMITE_ADMIN: ConfigDeRota = { max: 20, timeWindow: '1 minute' };
