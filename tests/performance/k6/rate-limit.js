// Custo do contador compartilhado no caminho da requisição.
//
// O RNF-01 da SPEC 016 diz que o rate limit não pode acrescentar mais que 5 ms ao p95. O
// cenário mede uma rota barata e limitada, de muitos IPs distintos, para o contador ser
// exercitado sem que ninguém estoure o teto — o que se quer medir é a ida ao banco, não o
// caminho do 429.
//
// Compare com o baseline: rode uma vez com RATE_LIMIT_STORE=memory e outra com `mongo`. A
// diferença entre os dois p95 é o custo real do contador compartilhado.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';

const barrados = new Counter('requisicoes_barradas');

export const options = {
  scenarios: {
    contador: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 25 },
            { duration: '2m', target: 50 },
            { duration: '1m', target: 0 },
          ],
        },
  },
  thresholds: {
    // Teto do RNF-01 sobre uma rota que, sem contador, responde em poucos milissegundos.
    http_req_duration: ['p(95)<50'],
    http_req_failed: ['rate<0.01'],
    // Estourar o teto aqui significa que os IPs sintéticos colidiram e a medição virou
    // outra coisa: o caminho do 429, que é mais barato que o caminho normal.
    requisicoes_barradas: ['count==0'],
  },
};

/**
 * Um IP distinto por iteração.
 *
 * O `X-Forwarded-For` só é respeitado quando a origem é um proxy confiável — em ambiente de
 * carga local isso vale. Contra um ambiente onde não vale, o teste mede um IP só e vai
 * estourar o teto, que é o `requisicoes_barradas` acusando.
 */
function origemSintetica() {
  const octeto = (__VU * 251 + __ITER) % 65_536;
  return `10.${String(Math.floor(octeto / 256))}.${String(octeto % 256)}.1`;
}

export default function () {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: `carga-${String(__VU)}@iam.local`, senha: 'S3nh@DeCarga!' }),
    { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': origemSintetica() } },
  );

  // 401 é o esperado: a conta não existe. O que importa é o tempo, não a credencial.
  check(res, { 'não foi barrado': (r) => r.status !== 429 });
  if (res.status === 429) {
    barrados.add(1);
  }
}
