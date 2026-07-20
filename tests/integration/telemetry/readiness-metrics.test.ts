/**
 * Cobre as métricas de prontidão, que consomem o ponto de coleta que a SPEC de health
 * deixou pronto: transição vira contador, duração de cada checagem vira histograma.
 *
 * A transição é o dado que responde "desde quando" durante um incidente — a informação
 * que o log de transição já dava para quem estava lendo o log naquele instante, e que a
 * métrica passa a dar para quem chega depois.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarServicoDeProntidao } from '../../../src/modules/health/services/prontidao.service.js';
import type { EstadoDeDependencia } from '../../../src/modules/health/services/verificadores.js';
import {
  iniciarTelemetria,
  lerExposicaoPrometheus,
  type Telemetria,
} from '../../../src/telemetry/sdk.js';
import { obterInstrumentos } from '../../../src/telemetry/metricas.js';
import { esquemaTelemetria } from '../../../src/config/env.js';
import { criarLogger } from '../../../src/shared/logger/index.js';

let telemetria: Telemetria;

beforeAll(() => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({}));
});

afterAll(async () => {
  await telemetria.encerrar();
});

async function exposicao(): Promise<string> {
  const exportador = telemetria.exportadorPrometheus;
  if (exportador === undefined) throw new Error('exportador ausente — teste sem valor');
  return lerExposicaoPrometheus(exportador);
}

/** Verificador controlado pelo teste, para forçar a transição sem derrubar container. */
function verificadorControlavel(estado: {
  atual: 'up' | 'down';
}): () => Promise<EstadoDeDependencia> {
  return () =>
    Promise.resolve({
      nome: 'postgres' as const,
      estado: estado.atual,
      duracao_ms: 12,
    });
}

describe('métricas de prontidão', () => {
  it('a transição de up para down incrementa iam_readiness_transitions_total', async () => {
    const estado: { atual: 'up' | 'down' } = { atual: 'up' };
    const servico = criarServicoDeProntidao({
      verificadores: [verificadorControlavel(estado)],
      cacheMs: 0,
      logger: criarLogger({ nivel: 'fatal' }),
      coletor: obterInstrumentos('e54a0fd'),
    });

    // Primeira checagem estabelece a linha de base — não é transição.
    await servico.consultar();
    estado.atual = 'down';
    await servico.consultar();

    const linhas = (await exposicao())
      .split('\n')
      .filter((linha) => linha.startsWith('iam_readiness_transitions_total'));

    expect(linhas.join('\n')).toContain('dependencia="postgres"');
    expect(linhas.join('\n')).toContain('para="down"');
  });

  it('a duração de cada checagem alimenta o histograma', async () => {
    const servico = criarServicoDeProntidao({
      verificadores: [verificadorControlavel({ atual: 'up' })],
      cacheMs: 0,
      logger: criarLogger({ nivel: 'fatal' }),
      coletor: obterInstrumentos('e54a0fd'),
    });

    await servico.consultar();

    const texto = await exposicao();

    expect(texto).toContain('# TYPE iam_readiness_check_duration_seconds histogram');
    expect(texto).toContain('iam_readiness_check_duration_seconds_count{dependencia="postgres"}');
  });

  it('sem coletor injetado, o serviço segue funcionando', async () => {
    // Telemetria desligada não pode alterar o comportamento do readiness: a prontidão é
    // função, a métrica é diagnóstico.
    const servico = criarServicoDeProntidao({
      verificadores: [verificadorControlavel({ atual: 'up' })],
      cacheMs: 0,
      logger: criarLogger({ nivel: 'fatal' }),
    });

    await expect(servico.consultar()).resolves.toMatchObject({ pronto: true });
  });
});
