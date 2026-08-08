/**
 * Responsabilidade: adaptar `POST /oauth/token` ao `OAuthService` — extrair a credencial do
 * cliente, montar o pedido e devolver a resposta da RFC 6749 §5.1.
 * Regras:
 *  - A tradução de erro não é feita aqui: o escopo encapsulado tem um tratador próprio, então
 *    qualquer `ErroDeOAuth` lançado sobe e sai no formato certo em um lugar só.
 *  - `Cache-Control: no-store` e `Pragma: no-cache` acompanham **toda** resposta (§5.1): um
 *    proxy que cacheie a resposta de token entrega credencial ao próximo cliente.
 *  - O log fica na borda (tem `trace_id`) e nunca inclui segredo, senha ou token.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extrairCredencialDeCliente } from '../services/client-credentials.js';
import { CABECALHOS_SEM_CACHE } from '../routes/oauth-error-handler.js';
import type { OAuthService } from '../services/oauth.service.js';
import type { CorpoDeToken } from '../schemas/oauth.schema.js';

export interface DependenciasDoControllerDeOAuth {
  readonly oauthService: OAuthService;
}

export interface ControllerDeOAuth {
  token(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

export function criarControllerDeOAuth(deps: DependenciasDoControllerDeOAuth): ControllerDeOAuth {
  return {
    async token(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const corpo = requisicao.body as CorpoDeToken;
      const credencial = extrairCredencialDeCliente(requisicao.headers.authorization, corpo);

      const concedido = await deps.oauthService.emitir({
        grantType: corpo.grant_type,
        credencial,
        escoposSolicitados: corpo.scope,
        username: corpo.username,
        password: corpo.password,
        refreshToken: corpo.refresh_token,
      });

      requisicao.log.info(
        {
          evento: 'oauth.token_emitido',
          grant_type: corpo.grant_type,
          client_id: credencial.clientId,
          escopo_concedido: concedido.scope,
        },
        'token emitido',
      );

      await resposta
        .status(200)
        .headers(CABECALHOS_SEM_CACHE)
        .send({
          access_token: concedido.accessToken,
          token_type: concedido.tokenType,
          expires_in: concedido.expiresIn,
          scope: concedido.scope,
          ...(concedido.refreshToken === undefined
            ? {}
            : { refresh_token: concedido.refreshToken }),
        });
    },
  };
}
