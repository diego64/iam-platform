/**
 * Responsabilidade: registrar `GET /metrics`, o endpoint que o Prometheus raspa.
 * Regras:
 *  - A rota só existe com `METRICS_ENABLED=true`. Desligada, o 404 sai do handler padrão
 *    em problem+json — sem rota morta respondendo "desabilitado" a quem varre a internet.
 *  - Servido pela própria aplicação, e não por porta separada: o `prometheus.yml` já
 *    aponta para a porta do serviço, e um segundo servidor HTTP seria mais uma superfície
 *    a expor, configurar e manter.
 */
import type { FastifyInstance } from 'fastify';
import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { lerExposicaoPrometheus } from '../../../telemetry/sdk.js';

/** Content-type do formato de exposição — o Prometheus depende da versão declarada. */
const TIPO_EXPOSICAO = 'text/plain; version=0.0.4; charset=utf-8';

export interface DependenciasDeMetrics {
  readonly exportador: PrometheusExporter;
}

export function registrarRotaDeMetrics(
  app: FastifyInstance,
  dependencias: DependenciasDeMetrics,
): void {
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['observability'],
        summary: 'Métricas em formato Prometheus',
        description:
          'Registrado apenas quando METRICS_ENABLED=true. Em produção deve ficar restrito a rede interna — expõe topologia, nomes de rota e volume.',
        security: [],
      },
    },
    async (_requisicao, resposta) => {
      await resposta
        .type(TIPO_EXPOSICAO)
        .send(await lerExposicaoPrometheus(dependencias.exportador));
    },
  );
}
