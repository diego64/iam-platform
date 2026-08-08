// Escrita de auditoria sob carga.
//
// Cada login grava um evento na trilha, e a posição de cada evento é reservada por
// compare-and-set num único documento de topo. É o ponto de serialização do módulo: sob
// concorrência, quem perde a corrida relê e recalcula, e o custo aparece como latência do
// próprio login — não como erro.
//
// O que este teste mede, portanto, não é a trilha isolada: é se a trilha ligada mantém o
// login dentro do SLO dele (p95 < 250ms, o mesmo da autenticação sem auditoria) e se a
// disputa pelo topo se estabiliza em vez de crescer com a carga.
//
// Depois da execução, confira `iam_audit_chain_conflicts_total` em /metrics: conflito
// crescendo mais rápido que `iam_audit_events_total` é o sinal de que a cadeia única chegou
// ao teto e o caminho é particioná-la por dia.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === 'true';

// Conta de carga: precisa existir e estar ativa, para cada iteração gravar `iam.auth.login`.
const EMAIL = __ENV.LOAD_EMAIL || 'load@iam.local';
const SENHA = __ENV.LOAD_SENHA || 'S3nh@DeCarga!';

export const options = {
  scenarios: {
    escrita_de_trilha: SMOKE
      ? { executor: 'constant-vus', vus: 5, duration: '30s' }
      : {
          executor: 'constant-arrival-rate',
          rate: 200, // eventos/s sustentados — o piso declarado para a cadeia única
          timeUnit: '1s',
          duration: '2m',
          preAllocatedVUs: 100,
          maxVUs: 300,
        },
  },
  thresholds: {
    // O login com auditoria ligada continua no SLO de login sem auditoria.
    http_req_duration: ['p(95)<250'],
    // Contenção do topo não pode virar erro: quem perde a corrida repete, não falha.
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, senha: SENHA }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'login 200': (r) => r.status === 200 });
}
