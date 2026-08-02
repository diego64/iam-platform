// Carga da autenticação de cliente de API. O custo dominante é o scrypt do segredo, então
// o SLO aqui é o mesmo do login — é a mesma função de derivação, com o mesmo fator de
// trabalho.
//
// Requer um par CLIENT_ID/CLIENT_SECRET já registrado. Sem ele o teste falha em voz alta em
// vez de medir uma rajada de 401 e parecer rápido.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const CLIENT_ID = __ENV.CLIENT_ID || '';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
// Segredo anterior, quando há rotação em andamento. Opcional.
const CLIENT_SECRET_ANTERIOR = __ENV.CLIENT_SECRET_PREVIOUS || '';

const aceitosComAnterior = new Counter('autenticacoes_com_segredo_anterior');

export const options = {
  scenarios: {
    autenticacao: {
      executor: 'constant-vus',
      vus: 50,
      duration: '1m',
      exec: 'autenticar',
    },
  },
  thresholds: {
    // Mesmo teto do login: é o mesmo scrypt, com o mesmo custo.
    http_req_duration: ['p(95)<250'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  },
};

export function setup() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    fail('CLIENT_ID e CLIENT_SECRET são obrigatórios: sem eles isto mede 401, não autenticação');
  }
}

/**
 * Troca o par por um token. Enquanto a emissão OAuth2 não existir, aponte BASE_URL para o
 * harness local que expõe o serviço de autenticação de cliente.
 */
function trocarPorToken(secret) {
  return http.post(
    `${BASE}/oauth/token`,
    { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: secret },
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  );
}

export function autenticar() {
  const res = trocarPorToken(CLIENT_SECRET);

  check(res, {
    'status 200': (r) => r.status === 200,
    'devolve access_token': (r) => Boolean(r.json('access_token')),
    // O segredo enviado jamais pode voltar na resposta.
    'não ecoa o segredo': (r) => !r.body.includes(CLIENT_SECRET),
  });

  // Com rotação em andamento, o segredo anterior precisa continuar valendo sob carga — é a
  // janela inteira do deploy que depende disso.
  if (CLIENT_SECRET_ANTERIOR) {
    const anterior = trocarPorToken(CLIENT_SECRET_ANTERIOR);
    check(anterior, { 'segredo anterior ainda vale': (r) => r.status === 200 });
    if (anterior.status === 200) {
      aceitosComAnterior.add(1);
    }
  }
}
