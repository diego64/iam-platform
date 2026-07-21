/**
 * Responsabilidade: registrar `GET /metrics`, o endpoint que o Prometheus raspa.
 * Regras:
 *  - A rota só existe com `METRICS_ENABLED=true`. Desligada, o 404 sai do handler padrão
 *    em problem+json — sem rota morta respondendo "desabilitado" a quem varre a internet.
 *  - Servido pela própria aplicação, e não por porta separada: o `prometheus.yml` já
 *    aponta para a porta do serviço, e um segundo servidor HTTP seria mais uma superfície
 *    a expor, configurar e manter.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { lerExposicaoPrometheus } from '../../../telemetry/sdk.js';
import { montarProblema } from '../../../shared/errors/problem-json.js';

/** Content-type do formato de exposição — o Prometheus depende da versão declarada. */
const TIPO_EXPOSICAO = 'text/plain; version=0.0.4; charset=utf-8';

export interface DependenciasDeMetrics {
  readonly exportador: PrometheusExporter;
  /**
   * Em produção, recusa requisição que tenha atravessado o proxy público. `METRICS_PUBLIC`
   * desliga a guarda — e a liberação passa a ser uma decisão registrada na configuração,
   * não um default que ninguém escolheu.
   */
  readonly restringirAoInterno: boolean;
}

/**
 * Requisição que chegou pela internet, e não pela rede interna.
 *
 * No Render o tráfego externo entra por um proxy que sempre acrescenta `X-Forwarded-For`;
 * a raspagem do Prometheus na rede interna fala direto com o processo e não tem esse
 * cabeçalho. É a única distinção disponível sem acrescentar autenticação a um endpoint
 * que o scraper consome sem credencial.
 *
 * ponytail: heurística de um proxy só. Se entrar CDN ou service mesh na frente, isto vira
 * verificação de faixa de IP de origem.
 */
function veioDaInternet(requisicao: FastifyRequest): boolean {
  return requisicao.headers['x-forwarded-for'] !== undefined;
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
    async (requisicao, resposta) => {
      if (dependencias.restringirAoInterno && veioDaInternet(requisicao)) {
        // 404, não 403: o endpoint expõe topologia, nomes de rota e volume, e um 403
        // confirmaria a quem varre que ele existe e está apenas fechado.
        await resposta
          .status(404)
          .type('application/problem+json')
          .send(montarProblema('not-found', 'Recurso não encontrado', 404));
        return;
      }

      await resposta
        .type(TIPO_EXPOSICAO)
        .send(await lerExposicaoPrometheus(dependencias.exportador));
    },
  );
}
