// Rotação de refresh sob carga: cada VU loga uma vez e depois rotaciona em cadeia,
// sempre com o token mais novo — mede o custo de lookup + rotação atômica + assinatura.
import http from 'k6/http';
import { check, fail } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';
const EMAIL = __ENV.EMAIL || 'load@iam.local';
// Sem default: uma senha embutida aqui é uma credencial versionada, e o dia em que alguém
// apontar o script para um ambiente real ela vira a senha que ele tenta de verdade.
const SENHA = __ENV.SENHA || '';

export const options = {
  scenarios: {
    rotacao: SMOKE
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
    http_req_duration: ['p(95)<60'], // SLO: p95 da rotação < 60ms
    http_req_failed: ['rate<0.01'],
  },
};

const cabecalhos = { headers: { 'Content-Type': 'application/json' } };

/**
 * Portão único da execução: aborta antes de gerar carga quando falta a credencial.
 *
 * Validar aqui, e não dentro do cenário, evita dezenas de VUs disparando a falha em
 * paralelo e enterrando o motivo real no meio do relatório.
 */
export function setup() {
  if (!SENHA) {
    fail('SENHA ausente: sem ela o login falha e o cenário mede 401, não rotação');
  }
}

export default function () {
  const login = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: EMAIL, senha: SENHA }),
    cabecalhos,
  );
  let refresh = login.json('refresh_token');

  // Rotaciona em cadeia: o token novo de cada passo alimenta o próximo (sem reuso).
  for (let i = 0; i < 5 && refresh; i += 1) {
    const res = http.post(
      `${BASE}/auth/refresh`,
      JSON.stringify({ refresh_token: refresh }),
      cabecalhos,
    );
    check(res, { 'status 200': (r) => r.status === 200 });
    refresh = res.json('refresh_token');
  }
}
