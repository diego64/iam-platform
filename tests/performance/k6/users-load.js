// Carga de administração de usuários: separa o custo do POST /users (inclui scrypt) do
// GET /users (leitura barata), com SLOs distintos por rota.
//
// Requer um servidor com as rotas de /users no ar e um Bearer de admin em ADMIN_TOKEN — o
// concreto do autorizador (001/003) e o wiring do módulo ainda não existem, então este
// script é o artefato de carga a rodar quando existirem.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.ADMIN_TOKEN || '';
const SMOKE = __ENV.SMOKE === 'true';

export const options = {
  scenarios: {
    administracao: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 20 },
            { duration: '2m', target: 40 },
            { duration: '1m', target: 0 },
          ],
        },
  },
  thresholds: {
    // SLOs por rota (RNF-01/02): criação inclui scrypt; leitura é barata.
    'http_req_duration{rota:create}': ['p(95)<250'],
    'http_req_duration{rota:list}': ['p(95)<30'],
    http_req_failed: ['rate<0.01'],
  },
};

const cabecalhos = {
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
};

export default function () {
  const email = `load-${__VU}-${__ITER}@iam.local`;
  const criar = http.post(
    `${BASE}/users`,
    JSON.stringify({ email, senha: 'S3nh@DeCargaForte!' }),
    Object.assign({ tags: { rota: 'create' } }, cabecalhos),
  );
  check(criar, { 'create 201': (r) => r.status === 201 });

  const listar = http.get(
    `${BASE}/users?limit=20`,
    Object.assign({ tags: { rota: 'list' } }, cabecalhos),
  );
  check(listar, { 'list 200': (r) => r.status === 200 });
}
