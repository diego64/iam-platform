// Guard de autorização sob carga: rota RBAC protegida exercitando exigirPermissao.
// O guard verifica a claim `perm` do token em memória (sem I/O), então o overhead que
// ele adiciona sobre a validação do token deve ser mínimo — SLO p95 < 5ms.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

// Usuário de carga precisa ter a permissão `roles:read` (via algum papel) para receber 200.
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
    autorizacao_em_massa: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5'], // SLO: verificação do guard < 5ms
    http_req_failed: ['rate<0.001'],
  },
};

export default function (dados) {
  const res = http.get(`${BASE}/roles?limit=1`, {
    headers: { Authorization: `Bearer ${dados.token}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
