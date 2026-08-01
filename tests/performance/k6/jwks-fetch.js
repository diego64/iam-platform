// Carga do endpoint JWKS: raspagem do conjunto público servido do cache em memória.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    raspagem_jwks: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<10'], // SLO: JWKS servido do cache < 10ms
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE}/.well-known/jwks.json`);
  check(res, {
    'status 200': (r) => r.status === 200,
    'tem chaves': (r) => Array.isArray(r.json('keys')),
    'sem material privado': (r) => !r.body.includes('"d"'),
  });
}
