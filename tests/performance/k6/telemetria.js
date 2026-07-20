/**
 * Sobrecarga da instrumentação e custo da raspagem.
 *
 * Duas perguntas, e a primeira é a que decide se a observabilidade continua ligada:
 *
 * 1. Quanto a instrumentação acrescenta ao p95 de uma requisição normal (menos
 *    de 3 ms). Telemetria cara demais acaba desligada em produção "temporariamente" — e
 *    aí não existe observabilidade justamente quando ela é necessária.
 *
 * 2. Quanto custa servir o /metrics (RNF-02: p95 abaixo de 50 ms). A raspagem acontece a
 *    cada 15 s, indefinidamente: um endpoint caro vira carga permanente cobrada do mesmo
 *    processo que atende o tráfego real.
 *
 * A comparação exige DUAS instâncias, subidas fora deste script:
 *   METRICS_ENABLED=false PORT=3002 pnpm start   # linha de base, sem instrumentação
 *   METRICS_ENABLED=true  PORT=3000 pnpm start   # instrumentada
 *
 * A porta 3002, e não 3001: o compose de observabilidade publica o Grafana em 3001, e
 * apontar a linha de base para ele mediria o Grafana.
 *
 * Uso:
 *   k6 run tests/performance/k6/telemetria.js
 *   BASE_URL=http://127.0.0.1:3000 BASE_URL_SEM_TELEMETRIA=http://127.0.0.1:3002 \
 *     k6 run tests/performance/k6/telemetria.js
 *
 * MEDIÇÃO PAREADA, e essa é a decisão de desenho que vale explicar: cada iteração bate
 * nas duas instâncias e registra a DIFERENÇA. Comparar p95 de duas execuções separadas
 * mediria também a diferença de carga da máquina entre elas — em CI compartilhada, o
 * ruído facilmente supera os 3 ms que o SLO discute. Pareado, o ruído incide nas duas
 * pontas e sai na subtração, e o SLO vira um threshold de verdade em vez de um número
 * impresso no fim do relatório.
 *
 * Armadilha herdada do k6 de readiness: SLO de latência medido sob carga alta descreve a
 * fila do event loop, não o endpoint. Por isso a taxa é constante e moderada.
 */
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const INSTRUMENTADA = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const LINHA_DE_BASE = __ENV.BASE_URL_SEM_TELEMETRIA || 'http://127.0.0.1:3002';

// Rota comum às duas instâncias e FORA da lista de isenção. /health/live não serve: é
// isento de métrica e de trace, então mediria justamente o caminho que a instrumentação
// não toca — e daria um acréscimo de zero que não prova nada.
const ROTA = __ENV.ROTA || '/docs/json';

const pares = new Counter('telemetria_pares');
const acrescimo = new Trend('telemetria_acrescimo_ms', true);
const latenciaInstrumentada = new Trend('telemetria_latencia_instrumentada', true);
const latenciaLinhaDeBase = new Trend('telemetria_latencia_linha_de_base', true);
const latenciaMetrics = new Trend('telemetria_latencia_metrics', true);

export const options = {
  scenarios: {
    pareado: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '40s',
      preAllocatedVUs: 20,
      exec: 'compararPareado',
    },
    // Uma raspagem a cada poucos segundos é o ritmo real do Prometheus; medir mais
    // rápido que isso mediria um cenário que não existe.
    raspagem: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '3s',
      duration: '40s',
      preAllocatedVUs: 2,
      exec: 'raspar',
    },
  },
  thresholds: {
    // O acréscimo da instrumentação, medido par a par.
    telemetria_acrescimo_ms: ['p(95)<3'],
    // Garante que o teste exercitou de verdade, em vez de passar por vacuidade. Um
    // contador à parte porque Trend do k6 não aceita agregação `count`.
    telemetria_pares: ['count>800'],
    // RNF-02: custo de servir a raspagem.
    telemetria_latencia_metrics: ['p(95)<50'],
    http_req_failed: ['rate==0'],
  },
};

export function compararPareado() {
  // Ordem alternada por iteração: sempre bater primeiro na mesma instância daria a ela a
  // vantagem (ou o ônus) sistemática do primeiro acesso, e essa assimetria entraria
  // inteira na diferença que o SLO mede.
  const baseAntes = __ITER % 2 === 0;

  const primeira = http.get(`${baseAntes ? LINHA_DE_BASE : INSTRUMENTADA}${ROTA}`);
  const segunda = http.get(`${baseAntes ? INSTRUMENTADA : LINHA_DE_BASE}${ROTA}`);

  const semTelemetria = baseAntes ? primeira : segunda;
  const comTelemetria = baseAntes ? segunda : primeira;

  latenciaLinhaDeBase.add(semTelemetria.timings.duration);
  latenciaInstrumentada.add(comTelemetria.timings.duration);
  acrescimo.add(comTelemetria.timings.duration - semTelemetria.timings.duration);
  pares.add(1);
}

export function raspar() {
  latenciaMetrics.add(http.get(`${INSTRUMENTADA}/metrics`).timings.duration);
}

export function handleSummary(dados) {
  const p95 = (nome) => dados.metrics[nome]?.values?.['p(95)'] ?? 0;

  const relatorio = [
    '',
    '=== Sobrecarga da instrumentação ===',
    `p95 sem telemetria : ${p95('telemetria_latencia_linha_de_base').toFixed(2)} ms`,
    `p95 com telemetria : ${p95('telemetria_latencia_instrumentada').toFixed(2)} ms`,
    `p95 do acréscimo   : ${p95('telemetria_acrescimo_ms').toFixed(2)} ms   (menos de 3 ms)`,
    `p95 GET /metrics   : ${p95('telemetria_latencia_metrics').toFixed(2)} ms  (menos de 50 ms)`,
    '',
    'O veredito é dos thresholds acima — o código de saída do k6 vem deles, não daqui.',
    '',
  ].join('\n');

  return {
    stdout: relatorio,
    'reports/k6-telemetria.json': JSON.stringify(dados, null, 2),
  };
}
