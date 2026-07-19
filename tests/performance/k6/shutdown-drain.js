/**
 * SLO do encerramento gracioso: nenhuma requisição em voo pode ser perdida quando o
 * processo recebe SIGTERM.
 *
 * Uso:
 *   1. suba o container:  docker run -d --name iam -p 3000:3000 ... iam-platform:local
 *   2. rode:              k6 run tests/performance/k6/shutdown-drain.js
 *   3. durante a carga:   docker stop iam
 *
 * O threshold é http_req_failed == 0. Qualquer resposta perdida reprova: é exatamente
 * a falha que o graceful shutdown existe para impedir. Um shutdown que fecha o socket
 * antes de drenar passaria em teste de unidade e falharia aqui.
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export const options = {
  scenarios: {
    carga_constante: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
    },
  },
  thresholds: {
    // Zero tolerância: uma única falha significa resposta perdida no shutdown.
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<200'],
  },
};

export default function () {
  const resposta = http.get(`${BASE}/health/live`);

  check(resposta, {
    'status 200': (r) => r.status === 200,
    'corpo com status ok': (r) => r.body && r.body.includes('"status":"ok"'),
  });
}
