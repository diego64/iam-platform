// Rotação pelo endpoint de token sob carga: cada VU troca a senha por um par vinculado ao
// cliente e depois renova em cadeia, sempre com o token mais novo.
//
// O que este cenário procura, além da latência, é falso positivo de reuso: a detecção da
// rotação derruba a família inteira quando um token gasto reaparece, e um erro de
// concorrência aqui apareceria como uma rajada de 400 no meio da carga — sessões legítimas
// caindo. Por isso `checks: ['rate==1']`: uma única renovação recusada reprova a execução.
//
// Requer um cliente com os grants `password` e `refresh_token` e um usuário de carga.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';
const CLIENT_ID = __ENV.CLIENT_ID || '';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const EMAIL = __ENV.EMAIL || 'load@iam.local';
// Sem default: senha embutida é credencial versionada, e o dia em que alguém apontar o
// script para um ambiente real ela vira a senha que ele tenta de verdade.
const SENHA = __ENV.SENHA || '';

const renovacoesRecusadas = new Counter('renovacoes_recusadas');

export const options = {
  scenarios: {
    renovacao: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '1m', target: 15 },
            { duration: '2m', target: 30 },
            { duration: '1m', target: 0 },
          ],
        },
  },
  thresholds: {
    // Inclui o scrypt do segredo do cliente, que domina o tempo — mesmo teto do login.
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
    renovacoes_recusadas: ['count==0'],
  },
};

const cabecalhos = { headers: { 'content-type': 'application/x-www-form-urlencoded' } };

export function setup() {
  if (!CLIENT_ID || !CLIENT_SECRET || !SENHA) {
    fail('CLIENT_ID, CLIENT_SECRET e SENHA são obrigatórios: sem eles isto mede 400, não rotação');
  }
}

export default function () {
  const inicial = http.post(
    `${BASE}/oauth/token`,
    {
      grant_type: 'password',
      username: EMAIL,
      password: SENHA,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    },
    cabecalhos,
  );
  check(inicial, { 'password grant 200': (r) => r.status === 200 });
  let refresh = inicial.json('refresh_token');

  // Renova em cadeia: o token novo de cada passo alimenta o próximo (sem reuso).
  for (let i = 0; i < 5 && refresh; i += 1) {
    const res = http.post(
      `${BASE}/oauth/token`,
      {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
      cabecalhos,
    );
    check(res, { 'renovação 200': (r) => r.status === 200 });
    if (res.status !== 200) {
      renovacoesRecusadas.add(1);
      break;
    }
    refresh = res.json('refresh_token');
  }
}
