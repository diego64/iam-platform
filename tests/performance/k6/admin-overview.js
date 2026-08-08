// Visões do painel sob carga.
//
// Duas medidas diferentes no mesmo teste, porque os custos são de naturezas diferentes:
//
// - a visão da tela inicial, com o cache quente, não deve tocar banco nenhum; o que se mede
//   ali é a serialização e o guard, e o SLO é apertado de propósito (p95 < 50ms). Se o número
//   subir, o cache não está sendo aproveitado — janela curta demais ou réplicas demais.
// - a ficha do usuário agrega cinco fontes a cada chamada, entre PostgreSQL e Mongo, e não é
//   cacheada. O SLO é mais folgado (p95 < 200ms) e mede a agregação de verdade.
//
// O usuário de carga precisa ter `admin:read`; o alvo da ficha é qualquer id existente.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const EMAIL = __ENV.LOAD_EMAIL || 'load@iam.local';
const SENHA = __ENV.LOAD_SENHA || 'S3nh@DeCarga!';
const ALVO = __ENV.LOAD_TARGET_ID || '';

export function setup() {
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, senha: SENHA }), {
    headers: { 'Content-Type': 'application/json' },
  });
  return { token: res.json('access_token') };
}

export const options = {
  scenarios: {
    visao_geral: {
      executor: 'constant-vus',
      vus: 50,
      duration: '1m',
      exec: 'visaoGeral',
    },
    ficha_de_usuario: {
      executor: 'constant-vus',
      vus: 20,
      duration: '1m',
      startTime: '1m',
      exec: 'ficha',
    },
  },
  thresholds: {
    'http_req_duration{cenario:overview}': ['p(95)<50'],
    'http_req_duration{cenario:ficha}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export function visaoGeral(dados) {
  const res = http.get(`${BASE}/admin/overview`, {
    headers: { Authorization: `Bearer ${dados.token}` },
    tags: { cenario: 'overview' },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    // Cache frio em toda requisição significaria que o teto medido não é o do cache quente.
    'veio do cache': (r) => r.json('cache') === 'hit',
  });
}

export function ficha(dados) {
  const res = http.get(`${BASE}/admin/users/${ALVO}`, {
    headers: { Authorization: `Bearer ${dados.token}` },
    tags: { cenario: 'ficha' },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
