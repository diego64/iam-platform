/**
 * Responsabilidade: subir e derrubar o SDK do OpenTelemetry — recurso, instrumentação
 * automática, exportador de métricas (raspado) e de traces (empurrado por OTLP).
 * Consumido por: `telemetry/index.ts` (que é importado na primeira linha do server.ts)
 * e pelos testes, que chamam `iniciarTelemetria` com configuração explícita.
 * Regras:
 *  - Nenhum caminho lança. Telemetria é diagnóstico, não função: uma configuração
 *    ruim de coletor não pode impedir o serviço de subir.
 *  - Não importa `fastify`, `pg` nem `mongodb`. Importar aqui qualquer módulo que a
 *    instrumentação envolve o carregaria antes do `sdk.start()`, e a substituição de
 *    métodos deixaria de acontecer — sem erro, sem span, sem aviso.
 */
import { createRequire } from 'node:module';
import { NodeSDK, resources, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { carregarConfigDeTelemetria, type ConfigDeTelemetria } from '../config/env.js';
import { ROTAS_ISENTAS } from './rotas-isentas.js';

export interface Telemetria {
  /** Alguma coisa subiu — métricas, traces ou os dois. */
  readonly ativa: boolean;
  /** Pipeline de métricas ligado (`METRICS_ENABLED`). */
  readonly metricas: boolean;
  /** Pipeline de traces ligado (exige `OTEL_EXPORTER_OTLP_ENDPOINT`). */
  readonly traces: boolean;
  /** Fonte do texto servido em `GET /metrics`. Ausente com métricas desligadas. */
  readonly exportadorPrometheus?: PrometheusExporter;
  /** Descarrega o que estiver em buffer e derruba o SDK. Nunca rejeita. */
  encerrar(): Promise<void>;
}

/** Handle inerte — usado quando nada foi ligado, para o resto do código não ramificar. */
const TELEMETRIA_DESLIGADA: Telemetria = {
  ativa: false,
  metricas: false,
  traces: false,
  encerrar: () => Promise.resolve(),
};

/**
 * Uma sonda a cada poucos segundos e uma raspagem a cada 15 s gerariam mais spans que o
 * tráfego real, e um trace de health check não responde pergunta nenhuma.
 */
function ignorarSondas(url: string): boolean {
  const caminho = url.split('?')[0] ?? url;
  return ROTAS_ISENTAS.has(caminho);
}

/**
 * Instrumentações automáticas de `fastify`, `pg` e `mongodb`, mais o `http` que as
 * amarra. O resto do catálogo (fs, dns, net, ...) fica desligado: gera volume alto de
 * spans que ninguém consulta e encarece o caminho da requisição sem contrapartida.
 */
function instrumentacoes(): ReturnType<typeof getNodeAutoInstrumentations> {
  return getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (requisicao) => ignorarSondas(requisicao.url ?? ''),
    },
    // Publica séries `nodejs_*` e `v8js_*` com rótulos fora da lista fechada da SPEC, e
    // o que elas medem (event loop, heap) é perfilamento — explicitamente fora de escopo.
    // O teste de contrato de rótulos reprova se voltarem.
    '@opentelemetry/instrumentation-runtime-node': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
  });
}

/**
 * Sobe o SDK conforme a configuração.
 *
 * Assimetria deliberada entre os dois pipelines (design.md §8): o Prometheus raspa, então
 * métricas precisam de endpoint local; o Tempo recebe push, então traces vão por OTLP.
 * Sem `OTEL_EXPORTER_OTLP_ENDPOINT` o pipeline de traces simplesmente não sobe — é a
 * configuração legítima de quem não coleta, não um erro.
 */
export function iniciarTelemetria(
  config: ConfigDeTelemetria = carregarConfigDeTelemetria(),
): Telemetria {
  const metricas = config.METRICS_ENABLED;
  const traces = config.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;

  if (!metricas && !traces) {
    return TELEMETRIA_DESLIGADA;
  }

  try {
    // `preventServerStart` porque o /metrics é servido pelo próprio Fastify: o
    // prometheus.yml já aponta para a porta da aplicação, e um segundo servidor HTTP
    // seria mais uma porta para expor, configurar e manter.
    //
    // `withoutScopeInfo` e `withoutTargetInfo` cortam rótulos que o exportador
    // acrescentaria sozinho: `otel_scope_name` em toda série e um `target_info` que
    // publica hostname, usuário do processo e a linha de comando completa. Nada disso é
    // consultado durante um incidente, e a lista fechada de rótulos da SPEC não os prevê
    // — rótulo entra fácil e o Prometheus o retém por meses.
    const exportadorPrometheus = metricas
      ? new PrometheusExporter({
          preventServerStart: true,
          withoutScopeInfo: true,
          withoutTargetInfo: true,
        })
      : undefined;

    const sdk = new NodeSDK({
      resource: resources.resourceFromAttributes({
        'service.name': config.OTEL_SERVICE_NAME,
        'service.version': versaoDaAplicacao(),
        'deployment.environment': config.NODE_ENV,
      }),
      // Respeita a decisão do pai para não quebrar trace distribuído quando existir mais
      // de um serviço; amostra por proporção quando a decisão é desta ponta.
      sampler: new tracing.ParentBasedSampler({
        root: new tracing.TraceIdRatioBasedSampler(config.OTEL_TRACES_SAMPLER_ARG),
      }),
      ...(exportadorPrometheus === undefined ? {} : { metricReader: exportadorPrometheus }),
      ...(config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : {
            // Em lote, fora do caminho da requisição: Collector fora derruba o buffer,
            // não a resposta ao cliente.
            spanProcessors: [
              new tracing.BatchSpanProcessor(
                new OTLPTraceExporter({ url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
              ),
            ],
          }),
      instrumentations: [instrumentacoes()],
    });

    sdk.start();

    return {
      ativa: true,
      metricas,
      traces,
      ...(exportadorPrometheus === undefined ? {} : { exportadorPrometheus }),
      encerrar: async () => {
        // Nunca rejeita: o encerramento do processo não pode travar porque o Collector
        // não respondeu ao último flush.
        await sdk.shutdown().catch(() => undefined);
      },
    };
  } catch {
    return TELEMETRIA_DESLIGADA;
  }
}

/**
 * Corta rótulos que o exportador acrescentaria sozinho: `otel_scope_name` em toda série e
 * um `target_info` com hostname, usuário do processo e a linha de comando completa. Nada
 * disso é consultado durante um incidente e nada disso está na lista fechada de rótulos.
 *
 * A ordem dos parâmetros posicionais é (prefixo, timestamp, rótulos de recurso,
 * semTargetInfo, semScopeInfo).
 */
const SERIALIZADOR = new PrometheusSerializer(undefined, false, undefined, true, true);

/**
 * Texto de exposição do Prometheus, como o scraper o veria.
 *
 * Mora aqui, e não no controller, para que a rota e os testes leiam pelo mesmo caminho —
 * um serializador configurado à parte no teste passaria a validar rótulos que a rota real
 * não emite.
 */
export async function lerExposicaoPrometheus(exportador: PrometheusExporter): Promise<string> {
  const { resourceMetrics } = await exportador.collect();
  return SERIALIZADOR.serialize(resourceMetrics);
}

/**
 * Versão publicada como `service.version` e como rótulo de `iam_build_info`.
 *
 * Lida do package.json que o Dockerfile copia para o runtime. `createRequire` em vez de
 * `import ... with { type: 'json' }` porque a segunda forma ainda emite aviso
 * experimental no Node 22 e poluiria o stderr de todo boot.
 */
export function versaoDaAplicacao(): string {
  try {
    const manifesto = createRequire(import.meta.url)('../../package.json') as {
      version?: unknown;
    };
    return typeof manifesto.version === 'string' ? manifesto.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}
