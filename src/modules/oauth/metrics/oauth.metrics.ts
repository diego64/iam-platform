/**
 * Responsabilidade: os instrumentos do endpoint de token — emissões, recusas por código,
 * duração e o sinal de refresh apresentado pelo cliente errado.
 * Consumido por: o `OAuthService`.
 * Regras:
 *  - Meter do OTel direto; com telemetria desligada, tudo vira no-op.
 *  - `erro` é rotulado com o código da RFC 6749, que é lista fechada de seis valores. Nunca
 *    `client_id` nem escopo: cardinalidade e rastro de quem chamou.
 *  - O descasamento de cliente tem contador próprio porque é sinal de token vazando entre
 *    clientes — o tipo de evento que merece alerta, não uma linha perdida num rótulo.
 */
import { metrics } from '@opentelemetry/api';
import type { CodigoDeErroOAuth } from '../errors/oauth-error.js';

const ESCOPO = 'iam-platform';

const FRONTEIRAS_SEGUNDOS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const GRANTS_ROTULAVEIS = new Set(['client_credentials', 'password', 'refresh_token']);

/**
 * O `grant_type` chega do corpo da requisição, então é texto de quem chamou. Rotular sem
 * fechar a lista deixaria qualquer um criar séries novas no Prometheus só mandando valores
 * diferentes — cardinalidade ilimitada por requisição anônima.
 */
export function rotuloDeGrant(valor: string): string {
  return GRANTS_ROTULAVEIS.has(valor) ? valor : 'desconhecido';
}

export interface MedidorDeOAuth {
  contarEmissao(grantType: string): void;
  contarRecusa(grantType: string, erro: CodigoDeErroOAuth): void;
  contarDescasamentoDeCliente(): void;
  observarDuracao(grantType: string, segundos: number): void;
}

export function criarMedidorDeOAuth(): MedidorDeOAuth {
  const meter = metrics.getMeter(ESCOPO);

  const emissoes = meter.createCounter('iam_oauth_token_total', {
    description: 'Requisições ao endpoint de token, por grant e resultado',
  });
  const recusas = meter.createCounter('iam_oauth_token_denied_total', {
    description: 'Requisições recusadas, pelo código de erro da RFC 6749',
  });
  const descasamentos = meter.createCounter('iam_oauth_refresh_client_mismatch_total', {
    description: 'Refresh token apresentado por um cliente que não é o dono da família',
  });
  const duracao = meter.createHistogram('iam_oauth_token_duration_seconds', {
    description: 'Duração da emissão de token, por grant',
    unit: 's',
    advice: { explicitBucketBoundaries: FRONTEIRAS_SEGUNDOS },
  });

  return {
    contarEmissao(grantType) {
      emissoes.add(1, { grant_type: rotuloDeGrant(grantType), resultado: 'success' });
    },
    contarRecusa(grantType, erro) {
      emissoes.add(1, { grant_type: rotuloDeGrant(grantType), resultado: 'denied' });
      recusas.add(1, { erro });
    },
    contarDescasamentoDeCliente() {
      descasamentos.add(1);
    },
    observarDuracao(grantType, segundos) {
      duracao.record(segundos, { grant_type: rotuloDeGrant(grantType) });
    },
  };
}

/** Medidor no-op, para testes e para o app sem telemetria. */
export function medidorDeOAuthNulo(): MedidorDeOAuth {
  return {
    contarEmissao() {
      /* no-op */
    },
    contarRecusa() {
      /* no-op */
    },
    contarDescasamentoDeCliente() {
      /* no-op */
    },
    observarDuracao() {
      /* no-op */
    },
  };
}
