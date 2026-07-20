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
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK, resources, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { carregarConfigDeTelemetria, type ConfigDeTelemetria } from '../config/env.js';
import { criarLogger, type Logger } from '../shared/logger/index.js';
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

/** Janela de agregação das falhas de exportação. */
const INTERVALO_DE_AGREGACAO_MS = 60_000;

/**
 * Concentra as falhas de exportação numa linha por minuto.
 *
 * O OTel reporta cada falha pelo `diag`, e um Collector fora produz uma por lote, sem
 * parar. Repassadas uma a uma, elas enterrariam o resto do log justamente durante o
 * incidente em que alguém precisa lê-lo — a telemetria viraria o problema.
 *
 * Devolve a função que desarma o agregador.
 */
function agregarFalhasDeExportacao(logger: Logger): () => void {
  let falhas = 0;
  const silencio = (): void => undefined;

  diag.setLogger(
    {
      error: () => {
        falhas += 1;
      },
      warn: () => {
        falhas += 1;
      },
      info: silencio,
      debug: silencio,
      verbose: silencio,
    },
    DiagLogLevel.WARN,
  );

  const relogio = setInterval(() => {
    if (falhas === 0) return;
    logger.warn({ falhas, janela_ms: INTERVALO_DE_AGREGACAO_MS }, 'telemetria.exportacao_falhou');
    falhas = 0;
  }, INTERVALO_DE_AGREGACAO_MS);

  // Sem unref, este timer sozinho manteria o processo vivo depois do shutdown.
  relogio.unref();

  return () => {
    clearInterval(relogio);
    diag.disable();
  };
}

/**
 * Atributos que a instrumentação automática acrescenta e a SPEC proíbe.
 *
 * As instrumentações de `pg` e `mongodb` publicam `db.connection_string` — que carrega
 * host, porta e nome do banco — e `db.user`. Juntos, descrevem a topologia interna para
 * qualquer um com acesso ao backend de traces, e nada disso é necessário para responder
 * "por que esta requisição demorou".
 */
const ATRIBUTOS_PROIBIDOS = ['db.connection_string', 'db.user'] as const;

/**
 * Remove os atributos proibidos antes de o span sair do processo.
 *
 * Registrado ANTES do processor de lote: o lote guarda o span por referência e serializa
 * depois, então a limpeza precisa acontecer no `onEnd` que roda primeiro.
 */
function limparAtributosSensiveis(): tracing.SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => {
      for (const chave of ATRIBUTOS_PROIBIDOS) {
        if (chave in span.attributes) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete (span.attributes as Record<string, unknown>)[chave];
        }
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
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
  logger: Logger = criarLogger({ nivel: 'warn' }),
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
              limparAtributosSensiveis(),
              new tracing.BatchSpanProcessor(
                new OTLPTraceExporter({
                  url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
                  // Teto curto por tentativa: com o Collector fora, o default deixaria o
                  // encerramento pendurado esperando um flush que não vai completar, e o
                  // orquestrador mataria o processo por timeout — perdendo também as
                  // requisições em voo que o shutdown gracioso existe para drenar.
                  timeoutMillis: 2_000,
                }),
                {
                  // Fila limitada: Collector fora por horas não pode virar vazamento de
                  // memória. Cheia, o processor descarta span — telemetria é diagnóstico,
                  // e perder diagnóstico é melhor que derrubar o serviço que ele observa.
                  maxQueueSize: 2_048,
                  exportTimeoutMillis: 2_000,
                },
              ),
            ],
          }),
      instrumentations: [instrumentacoes()],
    });

    sdk.start();
    const desarmarAgregador = agregarFalhasDeExportacao(logger);

    return {
      ativa: true,
      metricas,
      traces,
      ...(exportadorPrometheus === undefined ? {} : { exportadorPrometheus }),
      encerrar: async () => {
        desarmarAgregador();
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
