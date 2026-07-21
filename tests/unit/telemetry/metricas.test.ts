/**
 * Cobre os instrumentos e o contrato de rótulos: o que é publicado, com que nome, e a
 * regra de que rota é sempre template — nunca o caminho que o cliente mandou.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  criarInstrumentos,
  rotuloDeRota,
  ROTA_DESCONHECIDA,
  type Instrumentos,
} from '../../../src/telemetry/metricas.js';
import {
  iniciarTelemetria,
  lerExposicaoPrometheus,
  type Telemetria,
} from '../../../src/telemetry/sdk.js';
import { esquemaTelemetria } from '../../../src/config/env.js';

let telemetria: Telemetria;
let instrumentos: Instrumentos;

// Um SDK por arquivo, não por caso: o OTel registra o MeterProvider num singleton global
// e ignora registros seguintes. Subir um SDK por teste faria os instrumentos continuarem
// escrevendo no provider do primeiro, enquanto a leitura sairia do exportador do último —
// e todas as séries apareceriam vazias.
beforeAll(() => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({ GIT_COMMIT: 'e54a0fd' }));
  instrumentos = criarInstrumentos('e54a0fd');
});

afterAll(async () => {
  await telemetria.encerrar();
});

/** Texto de exposição, exatamente como o Prometheus veria ao raspar. */
async function exposicao(): Promise<string> {
  const exportador = telemetria.exportadorPrometheus;
  return exportador === undefined ? '' : lerExposicaoPrometheus(exportador);
}

/** Linhas de série (sem HELP/TYPE/UNIT) cujo nome começa pelo prefixo informado. */
function series(texto: string, prefixo: string): string[] {
  return texto.split('\n').filter((linha) => linha.startsWith(prefixo));
}

describe('iam_build_info', () => {
  it('publica version, commit e node_version', async () => {
    const texto = await exposicao();
    const [linha] = series(texto, 'iam_build_info');

    expect(linha).toBeDefined();
    expect(linha).toContain('commit="e54a0fd"');
    expect(linha).toContain(`node_version="${process.version}"`);
    expect(linha).toMatch(/version="\d+\.\d+\.\d+[^"]*"/);
    expect(linha?.trimEnd().endsWith(' 1')).toBe(true);
  });

  it('é um gauge fixo em 1 — serve de sinal de "serviço instrumentado"', async () => {
    expect(await exposicao()).toContain('# TYPE iam_build_info gauge');
  });
});

describe('métricas de requisição', () => {
  it('expõe duração e contagem com os nomes do contrato', async () => {
    instrumentos.registrarRequisicao(
      { method: 'GET', route: '/users/:id', status_code: 200 },
      0.012,
    );

    const texto = await exposicao();

    expect(texto).toContain('# TYPE iam_http_request_duration_seconds histogram');
    expect(texto).toContain('# TYPE iam_http_requests_total counter');
    expect(series(texto, 'iam_http_requests_total')[0]).toContain('route="/users/:id"');
  });

  it('mil ids distintos, uma série só — o template é o rótulo', async () => {
    for (let id = 0; id < 1_000; id += 1) {
      instrumentos.registrarRequisicao(
        { method: 'GET', route: rotuloDeRota('/users/:id'), status_code: 200 },
        0.01,
      );
    }

    const texto = await exposicao();

    expect(series(texto, 'iam_http_requests_total')).toHaveLength(1);
    expect(texto).not.toMatch(/route="\/users\/\d+"/);
  });
});

describe('métricas de prontidão', () => {
  it('conta transições por dependência e estado de destino', async () => {
    instrumentos.registrarTransicaoDeProntidao('postgres', 'down');

    const [linha] = series(await exposicao(), 'iam_readiness_transitions_total');

    expect(linha).toContain('dependencia="postgres"');
    expect(linha).toContain('para="down"');
  });

  it('mede a duração de cada checagem', async () => {
    instrumentos.registrarChecagemDeProntidao('mongo', 0.03);

    const texto = await exposicao();

    expect(texto).toContain('# TYPE iam_readiness_check_duration_seconds histogram');
    expect(texto).toContain('iam_readiness_check_duration_seconds_count{dependencia="mongo"}');
  });
});

describe('rotuloDeRota — guarda de cardinalidade', () => {
  it('devolve o template quando a rota casou', () => {
    expect(rotuloDeRota('/users/:id')).toBe('/users/:id');
  });

  it.each([undefined, ''])('usa literal fixo quando não há template (%j)', (template) => {
    expect(rotuloDeRota(template)).toBe(ROTA_DESCONHECIDA);
  });

  it('nunca devolve o caminho recebido em requisição não roteada', () => {
    // Um 404 chega com o caminho que o cliente escolheu: usá-lo como rótulo daria a
    // terceiros o direito de criar séries no Prometheus até derrubá-lo.
    expect(rotuloDeRota(undefined)).not.toContain('/');
  });
});

describe('contrato de rótulos', () => {
  it('não expõe otel_scope_name nem target_info', async () => {
    instrumentos.registrarRequisicao({ method: 'GET', route: '/x', status_code: 200 }, 0.01);

    const texto = await exposicao();

    expect(texto).not.toContain('otel_scope_name');
    expect(texto).not.toContain('target_info');
  });
});
