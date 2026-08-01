/**
 * Carrega, no build, a extensão de tipos que o `@fastify/rate-limit` faz em
 * `FastifyContextConfig` — o campo `rateLimit` do `config` das rotas. O plugin só é importado
 * nos testes (fora do `tsconfig.build.json`), então sem este carregamento explícito o build não
 * enxerga o campo e o `tsc` reprova o `config: { rateLimit }` das rotas com limite por conta.
 */
import '@fastify/rate-limit';
