/**
 * SLO do readiness sob carga.
 *
 * Duas coisas são medidas, e a segunda importa mais que a primeira:
 *
 * 1. Latência com cache quente. A sonda do orquestrador tem timeout curto; se o
 *    readiness demora, ele mata a requisição e conclui "fora" sem receber diagnóstico.
 *
 * 2. Que o cache absorve a rajada. Sem ele, cada requisição vira uma consulta em cada
 *    banco, multiplicada pelo número de réplicas — o endpoint que existe para proteger
 *    passaria a ser carga. O sinal é indireto mas confiável: com o cache funcionando, a
 *    latência permanece plana conforme os VUs sobem; sem ele, ela acompanha o banco.
 *
 * Uso:
 *   k6 run tests/performance/k6/readiness.js
 *   BASE_URL=https://... k6 run tests/performance/k6/readiness.js
 */
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

const prontas = new Counter('readiness_prontas');
const degradadas = new Counter('readiness_degradadas');
const latenciaPronta = new Trend('readiness_latencia_pronta', true);

export const options = {
  scenarios: {
    // Como a sonda de verdade se comporta: poucas requisições por segundo, contínuas.
    // É aqui que o p95 apertado faz sentido — mede o endpoint, não a fila do processo.
    sonda: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 5,
      tags: { cenario: 'sonda' },
    },
    // Rajada: prova que o cache absorve concorrência sem degradar respostas nem
    // multiplicar consulta ao banco. Aqui a latência é dominada pela fila do event
    // loop, não pela checagem — medir p95 apertado neste cenário mediria o Node, não
    // o readiness.
    rajada: {
      executor: 'constant-vus',
      vus: 200,
      duration: '20s',
      startTime: '20s',
      tags: { cenario: 'rajada' },
    },
  },
  thresholds: {
    // Sob carga de sonda real, a resposta sai da memória.
    'readiness_latencia_pronta{cenario:sonda}': ['p(95)<5'],
    // Na rajada o que importa é não degradar: nenhuma resposta 503 e nenhum erro.
    readiness_degradadas: ['count==0'],
    http_req_failed: ['rate==0'],
    // Garante que o teste exercitou de verdade, em vez de passar por vacuidade.
    'readiness_prontas{cenario:sonda}': ['count>150'],
    'readiness_prontas{cenario:rajada}': ['count>1000'],
  },
};

export default function () {
  const resposta = http.get(`${BASE}/health/ready`);

  if (resposta.status === 200 && resposta.body && resposta.body.includes('"status":"ready"')) {
    prontas.add(1);
    latenciaPronta.add(resposta.timings.duration);
    return;
  }

  // 503 aqui não é erro do teste: é o endpoint reportando dependência fora. Contado à
  // parte para o threshold distinguir "readiness lento" de "ambiente quebrado".
  degradadas.add(1);
}
