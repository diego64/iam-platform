// PDP sob carga: `POST /policies/evaluate` decide sobre atributos informados no corpo, sem
// carregar recurso do banco. Mede a decisão em si, isolada do I/O que o guard faz em
// `carregarRecurso` — esse caminho tem orçamento de latência próprio, bem mais folgado.
//
// O cache do PDP tem TTL curto, então dentro da janela a decisão não toca o Postgres: o que
// sobra no tempo é o casamento textual da condição sobre o contexto. Se este p95 subir, o
// suspeito é a avaliação da condição ou o tamanho do conjunto de políticas aplicáveis — não
// o banco.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

// Usuário de carga precisa da permissão `policies:read` para receber 200.
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
    decisao_em_massa: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5'], // SLO: decisão do PDP < 5ms
    http_req_failed: ['rate<0.001'],
  },
};

export default function (dados) {
  // Metade das iterações é dono e metade não: exercita o caminho que casa a política de
  // posse e o caminho que percorre todas as aplicáveis sem satisfazer nenhuma (default-deny),
  // que é o mais caro dos dois.
  const dono = __ITER % 2 === 0;
  const corpo = JSON.stringify({
    subject: { sub: 'load-subject', roles: ['operator'], perm: ['policies:read'] },
    resource_type: 'user',
    resource: { owner_id: dono ? 'load-subject' : 'outro-usuario', type: 'user' },
    action: 'read',
  });

  const res = http.post(`${BASE}/policies/evaluate`, corpo, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dados.token}` },
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'decisão coerente com a posse': (r) => r.json('effect') === (dono ? 'permit' : 'deny'),
  });
}
