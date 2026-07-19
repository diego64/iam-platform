/**
 * SLO do encerramento gracioso: nenhuma requisição JÁ ACEITA pode ser descartada
 * quando o processo recebe SIGTERM.
 *
 * Uso:
 *   1. suba o container:  docker run -d --name iam -p 3000:3000 ... iam-platform:local
 *   2. rode:              k6 run tests/performance/k6/shutdown-drain.js
 *   3. durante a carga:   docker stop iam
 *
 * Por que o threshold NÃO é `http_req_failed: rate==0`:
 * depois que o servidor fecha o socket de escuta, toda requisição nova é recusada no
 * TCP — comportamento correto e esperado, mas o k6 contabiliza como http_req_failed.
 * Um threshold sobre essa métrica reprovaria um shutdown perfeito, e a única forma de
 * passar seria parar a carga antes do sinal, que é justamente o que se quer testar.
 *
 * O que caracteriza drain quebrado é o servidor ACEITAR a conexão e depois não entregar
 * a resposta: 5xx, corpo truncado, conexão cortada no meio. É isso que se mede aqui.
 * Conexão recusada (status 0) é contada à parte, como esperada pós-shutdown.
 */
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

/** Respostas aceitas pelo servidor e entregues íntegras. */
const respostasIntegras = new Counter('drain_respostas_integras');
/** Conexões recusadas: servidor já saiu. Esperado, não é falha. */
const conexoesRecusadas = new Counter('drain_conexoes_recusadas');
/** Aceitou a conexão e não entregou resposta válida. É ISTO que reprova. */
const respostasDescartadas = new Counter('drain_respostas_descartadas');

export const options = {
  scenarios: {
    carga_constante: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
    },
  },
  thresholds: {
    // Zero tolerância: uma requisição aceita e não respondida é trabalho perdido,
    // exatamente o que o graceful shutdown existe para impedir.
    drain_respostas_descartadas: ['count==0'],
    // Garante que o teste chegou a exercitar o servidor de verdade, em vez de
    // passar por vacuidade porque a app nunca subiu.
    drain_respostas_integras: ['count>1000'],
  },
};

export default function () {
  const resposta = http.get(`${BASE}/health/live`);

  if (resposta.status === 0) {
    // Sem conexão TCP: o servidor já encerrou. Esperado após o SIGTERM.
    conexoesRecusadas.add(1);
    return;
  }

  const integra =
    resposta.status === 200 && !!resposta.body && resposta.body.includes('"status":"ok"');

  if (integra) {
    respostasIntegras.add(1);
  } else {
    // Servidor aceitou a conexão e não entregou resposta válida.
    respostasDescartadas.add(1);
  }
}
