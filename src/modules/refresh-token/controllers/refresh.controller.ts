/**
 * Responsabilidade: adaptar a rota `POST /auth/refresh` ao serviço — extrair o token,
 * chamar a rotação e traduzir `ErroDeRefreshInvalido` para RFC 7807.
 * Regras:
 *  - Tradução explícita aqui (não depende do handler global), para o mesmo contrato valer
 *    num app de teste isolado.
 *  - Resposta 401 sempre genérica (`invalid-refresh-token`): o `motivo` real só vai ao log.
 *  - Log na borda (tem `trace_id`): `warn` no reuso (indício de roubo), `info` no resto.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeRefreshInvalido } from '../errors/refresh-token-error.js';
import type { RefreshTokenService } from '../services/refresh-token.service.js';
import type { RefreshBody } from '../schemas/refresh.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeRefresh {
  readonly refreshTokenService: Pick<RefreshTokenService, 'rotacionar'>;
}

export interface ControllerDeRefresh {
  rotacionar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

export function criarControllerDeRefresh(
  deps: DependenciasDoControllerDeRefresh,
): ControllerDeRefresh {
  return {
    async rotacionar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const { refresh_token } = requisicao.body as RefreshBody;
      try {
        const par = await deps.refreshTokenService.rotacionar(refresh_token);
        requisicao.log.info({ evento: 'refresh.rotacionado' }, 'refresh token rotacionado');
        await resposta.status(200).send({
          access_token: par.accessToken,
          refresh_token: par.refreshToken,
          token_type: 'Bearer',
          expires_in: par.expiraEmSegundos,
        });
      } catch (erro) {
        if (erro instanceof ErroDeRefreshInvalido) {
          const nivel = erro.motivo === 'reuso' ? 'warn' : 'info';
          requisicao.log[nivel](
            { evento: 'refresh.recusado', motivo: erro.motivo },
            'refresh token recusado',
          );
          await resposta
            .status(401)
            .type(TIPO_PROBLEM_JSON)
            .send(montarProblema('invalid-refresh-token', 'Refresh token inválido', 401));
          return;
        }
        throw erro;
      }
    },
  };
}
