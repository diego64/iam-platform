/**
 * Responsabilidade: a lista fechada de rotas que não geram métrica de requisição nem trace.
 * Consumido por: o SDK (para ignorar spans) e o hook de métricas do app.
 * Regras: mora sozinho porque o SDK não pode importar nada que arraste `fastify` —
 *         qualquer módulo instrumentado carregado antes do `sdk.start()` deixa de ser
 *         instrumentado, em silêncio.
 *
 * A sonda de liveness bate a cada poucos segundos e o Prometheus raspa a cada 15 s.
 * Incluí-las no histograma faria o p95 descrever o health check, não o serviço.
 */
export const ROTAS_ISENTAS: ReadonlySet<string> = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
]);

export function rotaIsenta(rota: string | undefined): boolean {
  return rota !== undefined && ROTAS_ISENTAS.has(rota);
}
