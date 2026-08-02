// Rotação sob carga: mantém login e validação em andamento enquanto uma rotação é
// disparada no meio da janela. O SLO é o mais duro da SPEC — zero requisição falha.
//
// Requer um token de operador com `keys:write` em OPERATOR_TOKEN. Sem ele, o cenário de
// rotação não roda e a carga vira só uma medição de base — o que é sinalizado no resumo,
// nunca reportado como sucesso da rotação.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN_OPERADOR = __ENV.OPERATOR_TOKEN || '';
const EMAIL = __ENV.LOGIN_EMAIL || 'admin@iam.local';
// Sem default: uma senha embutida aqui é uma credencial versionada, e o dia em que alguém
// apontar o script para um ambiente real ela vira a senha que ele tenta de verdade.
const SENHA = __ENV.LOGIN_PASSWORD || '';

const rotacoes = new Counter('rotacoes_concluidas');
const rotacoesRecusadas = new Counter('rotacoes_recusadas');

export const options = {
  scenarios: {
    // Carga contínua durante toda a janela: é ela que detecta a queda, se houver.
    trafego: {
      executor: 'constant-vus',
      vus: 50,
      duration: '90s',
      exec: 'trafego',
    },
    // Uma rotação no meio da janela, com a carga já em regime.
    rotacao: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: '30s',
      exec: 'rotacionar',
    },
  },
  thresholds: {
    // A promessa da SPEC: rotacionar não derruba requisição em voo.
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<250'],
    checks: ['rate==1'],
  },
};

/**
 * Portão único da execução: aborta antes de gerar carga quando falta credencial.
 *
 * Validar aqui, e não dentro do cenário, evita 50 VUs disparando falha em paralelo e
 * enterrando o motivo real no meio do relatório.
 */
export function setup() {
  if (!SENHA) {
    fail('LOGIN_PASSWORD ausente: sem ela o cenário mede 401, não login');
  }
  if (!TOKEN_OPERADOR) {
    fail('OPERATOR_TOKEN ausente: a rotação não seria exercitada nesta execução');
  }
}

export function trafego() {
  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, senha: SENHA }), {
    headers: { 'content-type': 'application/json' },
  });
  check(login, { 'login 200': (r) => r.status === 200 });

  const token = login.json('access_token');
  if (!token) return;

  // Validação com o token recém-emitido: é aqui que uma promoção mal feita apareceria,
  // com o consumidor rejeitando um kid que ainda não conhece.
  const perfil = http.get(`${BASE}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  check(perfil, { 'perfil 200 durante a rotação': (r) => r.status === 200 });

  const jwks = http.get(`${BASE}/.well-known/jwks.json`);
  check(jwks, {
    'jwks 200': (r) => r.status === 200,
    'jwks sem material privado': (r) => !r.body.includes('"d"'),
  });
}

export function rotacionar() {
  const cabecalhos = {
    headers: { authorization: `Bearer ${TOKEN_OPERADOR}`, 'content-type': 'application/json' },
  };

  const preparo = http.post(`${BASE}/admin/keys/prepare`, null, cabecalhos);
  check(preparo, { 'prepare 200 ou 201': (r) => r.status === 200 || r.status === 201 });

  const rotacao = http.post(
    `${BASE}/admin/keys/rotate`,
    JSON.stringify({ motivo: 'carga k6' }),
    cabecalhos,
  );

  // 409 aqui é resultado legítimo: a chave pré-publicada ainda não cumpriu a janela. O
  // cenário registra e segue — a carga continua medindo, e o contador diz o que houve.
  if (rotacao.status === 409) {
    rotacoesRecusadas.add(1);
  } else {
    rotacoes.add(1);
    check(rotacao, { 'rotate 200': (r) => r.status === 200 });
  }
}
