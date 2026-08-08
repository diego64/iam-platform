/**
 * Responsabilidade: dar ao 429 o mesmo formato do resto da plataforma.
 * Consumido por: o `setErrorHandler` do `app.ts` e o dos apps de teste.
 * Regras:
 *  - O corpo é problem+json com tipo próprio. Sem isto, o excesso cai no ramo genérico do
 *    tratador e sai como `request-error` — indistinguível de qualquer outro 4xx.
 *  - O `detail` **não** diz qual dimensão estourou: "o limite desta conta" confirmaria a
 *    existência da conta a quem sonda, e "deste IP" ensina a trocar de IP. A dimensão vive
 *    na métrica e no log.
 *  - **Por que aqui e não no `errorResponseBuilder` do plugin:** o `@fastify/rate-limit`
 *    *lança* o retorno daquele construtor em vez de enviá-lo, então o objeto atravessa o
 *    `setErrorHandler` da aplicação. Um objeto sem `statusCode` vira 500 no caminho. Deixar
 *    o plugin lançar o erro dele — que é um `Error` com `statusCode` — e formatar aqui é
 *    menos peça móvel e funciona igual em qualquer app que já tenha tratador.
 *  - `/oauth/*` nunca chega aqui: aquele prefixo tem tratador próprio, e responde no formato
 *    da RFC 6749 (SPEC 012).
 */
import { montarProblema } from '../errors/problem-json.js';

/** Reconhece o erro que o `@fastify/rate-limit` lança ao estourar o teto. */
export function ehExcessoDeRateLimit(erro: unknown): boolean {
  return (erro as { statusCode?: number } | null)?.statusCode === 429;
}

/** O corpo do 429, no formato RFC 7807. */
export function problemaDeRateLimit(): Record<string, unknown> {
  return {
    ...montarProblema('rate-limit-exceeded', 'Limite de requisições excedido', 429),
    detail: 'Tente novamente em alguns instantes.',
  };
}
