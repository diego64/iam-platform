// Validação em massa: rotas protegidas batendo em denylist + RBAC
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: 'load@iam.local', senha: 'S3nh@DeCarga!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { token: res.json('access_token') };
}

export const options = {
  scenarios: {
    validacao_em_massa: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<15'], // SLO: validação de JWT < 15ms
    http_req_failed: ['rate<0.001'],
  },
};

export default function (dados) {
  const res = http.get(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${dados.token}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
