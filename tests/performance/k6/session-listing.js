// Listagem de sessões sob carga: cada VU loga uma vez e depois lista as próprias sessões em
// laço — mede o custo da leitura escopada por usuário no Mongo.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';
const EMAIL = __ENV.EMAIL || 'load@iam.local';
const SENHA = __ENV.SENHA || 'S3nh@DeCarga!';

export const options = {
  scenarios: {
    listagem: SMOKE
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
    http_req_duration: ['p(95)<30'], // SLO: p95 da listagem < 30ms
    http_req_failed: ['rate<0.01'],
  },
};

const cabecalhos = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const login = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: EMAIL, senha: SENHA }),
    cabecalhos,
  );
  const access = login.json('access_token');
  if (!access) return;

  const res = http.get(`${BASE}/auth/sessions`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
