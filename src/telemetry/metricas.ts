/**
 * Responsabilidade: declarar os instrumentos de métrica e os rótulos que eles aceitam.
 * Consumido por: o hook de requisição do `app.ts` e o serviço de prontidão.
 * Regras:
 *  - Rótulo é lista fechada (ver `api.md`). O Prometheus retém rótulo por meses: dado
 *    sensível que entra ali não sai por expiração de sessão nem por revogação de token.
 *  - Rótulo de rota é sempre o template registrado, nunca o caminho recebido.
 */
import { metrics } from '@opentelemetry/api';
import { versaoDaAplicacao } from './sdk.js';

/** Nome do escopo — aparece na API do OTel, não nas séries expostas. */
const ESCOPO = 'iam-platform';

/**
 * Rótulo usado quando a requisição não casou com nenhuma rota registrada.
 *
 * Um 404 chega com um caminho que quem chamou escolheu. Usá-lo como rótulo entrega ao
 * cliente o poder de criar séries no Prometheus à vontade — cardinalidade ilimitada,
 * escrita por terceiros, retida por meses.
 */
export const ROTA_DESCONHECIDA = 'desconhecida';

/**
 * Fronteiras em segundos, do serviço rápido ao francamente quebrado.
 *
 * O default do OTel é orientado a milissegundos e colocaria toda requisição saudável no
 * primeiro balde, tornando o p95 inútil justamente na faixa que interessa.
 */
const FRONTEIRAS_SEGUNDOS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface RotulosDeRequisicao {
  readonly method: string;
  readonly route: string;
  readonly status_code: number;
}

export interface Instrumentos {
  /** Duração e contagem de uma requisição já concluída. */
  registrarRequisicao(rotulos: RotulosDeRequisicao, duracaoSegundos: number): void;
  /** Transição de estado de uma dependência de prontidão. */
  registrarTransicaoDeProntidao(dependencia: string, para: string): void;
  /** Duração de uma checagem de dependência, transicionando ou não. */
  registrarChecagemDeProntidao(dependencia: string, duracaoSegundos: number): void;
}

/**
 * Cria os instrumentos e publica o `iam_build_info` imediatamente.
 *
 * O build info é a primeira métrica publicada de propósito: a ausência dela no Prometheus
 * vira sinal claro de "serviço não instrumentado", em vez do silêncio ambíguo de um alvo
 * que responde 200 sem série nenhuma.
 *
 * Com a telemetria desligada, `metrics.getMeter` devolve o meter no-op do OTel e todas as
 * chamadas aqui viram no-op — sem ramificação e sem custo relevante.
 */
export function criarInstrumentos(commit: string): Instrumentos {
  const meter = metrics.getMeter(ESCOPO);

  meter.createGauge('iam_build_info', { description: 'Versão em execução' }).record(1, {
    version: versaoDaAplicacao(),
    commit,
    node_version: process.version,
  });

  const duracaoDeRequisicao = meter.createHistogram('iam_http_request_duration_seconds', {
    description: 'Duração das requisições HTTP',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  const totalDeRequisicoes = meter.createCounter('iam_http_requests', {
    description: 'Requisições HTTP atendidas',
  });

  const transicoesDeProntidao = meter.createCounter('iam_readiness_transitions', {
    description: 'Transições de estado das dependências',
  });

  const duracaoDeChecagem = meter.createHistogram('iam_readiness_check_duration_seconds', {
    description: 'Duração das checagens de prontidão',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    registrarRequisicao(rotulos, duracaoSegundos) {
      duracaoDeRequisicao.record(duracaoSegundos, { ...rotulos });
      totalDeRequisicoes.add(1, { ...rotulos });
    },

    registrarTransicaoDeProntidao(dependencia, para) {
      transicoesDeProntidao.add(1, { dependencia, para });
    },

    registrarChecagemDeProntidao(dependencia, duracaoSegundos) {
      duracaoDeChecagem.record(duracaoSegundos, { dependencia });
    },
  };
}

let instrumentos: Instrumentos | undefined;

/**
 * Instrumentos do processo, criados uma única vez.
 *
 * Dois consumidores precisam dos mesmos instrumentos — o hook de requisição e o serviço
 * de prontidão — e eles são construídos em pontos diferentes do bootstrap. Criar duas
 * vezes registraria o `iam_build_info` em duplicata e faria o OTel reclamar de conflito
 * de instrumento a cada boot.
 */
export function obterInstrumentos(commit: string): Instrumentos {
  instrumentos ??= criarInstrumentos(commit);
  return instrumentos;
}

/**
 * Traduz a rota casada pelo Fastify no rótulo `route`.
 *
 * `/users/42` precisa virar `/users/:id`: com o valor no lugar do template, cada usuário
 * criaria uma série própria. É assim que um sistema de observabilidade vira o incidente
 * — o Prometheus cai sob a cardinalidade e leva junto a capacidade de investigar.
 */
export function rotuloDeRota(template: string | undefined): string {
  return template === undefined || template === '' ? ROTA_DESCONHECIDA : template;
}
