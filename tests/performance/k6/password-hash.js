/**
 * Latência da troca de senha, dominada pelo custo do scrypt.
 *
 * A troca não faz um hash só: verifica a senha atual (1 derivação), checa reuso contra a
 * senha corrente e as últimas N do histórico (até N+1 derivações) e gera o novo hash
 * (1 derivação). O alvo de menos de 200 ms por hash isolado não se aplica ao endpoint
 * inteiro — este teste mede o caminho real, para o teto do endpoint ser calibrado com o
 * número de derivações que ele de fato executa.
 *
 * PRÉ-REQUISITO (por que este script ainda não roda no CI): a rota de troca é autenticada
 * e o servidor precisa estar de pé com o módulo de senha ligado a um repositório de
 * usuário real e a um verificador de access token — nenhum dos dois existe ainda. Até lá,
 * o script fica pronto e é executado à mão contra um ambiente que já tenha esses dois.
 *
 * Uso (quando houver servidor autenticado):
 *   TOKEN=<jwt> SENHA_ATUAL=<senha> BASE_URL=http://127.0.0.1:3000 \
 *     k6 run tests/performance/k6/password-hash.js
 */
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const TOKEN = __ENV.TOKEN || '';
const SENHA_ATUAL = __ENV.SENHA_ATUAL || '';

const latenciaTroca = new Trend('password_change_latencia', true);

export const options = {
  scenarios: {
    // Taxa constante e moderada: latência medida sob carga alta descreveria a fila do
    // event loop, não o custo do endpoint. Poucas trocas por segundo isolam o scrypt.
    troca: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 10,
    },
  },
  thresholds: {
    // Teto do endpoint inteiro, não de um hash: uma verificação + a checagem de reuso + a
    // geração do novo hash. Ajustar junto com o custo do scrypt e o tamanho do histórico.
    password_change_latencia: ['p(95)<600'],
    http_req_failed: ['rate==0'],
  },
};

export default function trocarSenha() {
  // Alterna entre duas senhas para não bater no bloqueio de reuso a cada iteração.
  const nova = `Tr0c@Senh@!${__ITER % 2}`;
  const resposta = http.post(
    `${BASE}/auth/password/change`,
    JSON.stringify({
      senha_atual: __ITER % 2 === 0 ? SENHA_ATUAL : `Tr0c@Senh@!1`,
      senha_nova: nova,
    }),
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } },
  );

  latenciaTroca.add(resposta.timings.duration);
}
