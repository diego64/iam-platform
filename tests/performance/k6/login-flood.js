// Inundação de scrypt: descobre o teto de RPS de login antes de estourar CPU
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';

export const options = {
  scenarios: {
    pico_de_login: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 25 },
            { duration: '2m', target: 50 },
            { duration: '2m', target: 100 },
            { duration: '1m', target: 0 },
          ],
        },
  },
  thresholds: {
    http_req_duration: ['p(95)<250'], // SLO: p95 do login < 250ms
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: 'load@iam.local', senha: 'S3nh@DeCarga!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'status 200': (r) => r.status === 200 });
}
