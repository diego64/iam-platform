/**
 * Responsabilidade: montar `POST /oauth/token` num escopo Fastify encapsulado, com o parser
 * de formulário, o tratador de erro da RFC 6749 e o rate limit da rota.
 * Regras:
 *  - Tudo o que diverge do resto da plataforma (formulário, formato de erro) vive **dentro**
 *    do escopo. Fora dele, a aplicação continua só com JSON e problem+json.
 *  - O tipo de mídia é conferido antes da validação: o parser de JSON herdado da instância-mãe
 *    aceitaria um corpo `application/json` e o endpoint acabaria emitindo token por um caminho
 *    que a RFC não prevê.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeOAuth,
  type DependenciasDoControllerDeOAuth,
} from '../controllers/oauth.controller.js';
import { corpoDeToken, erroDeOAuth, respostaDeToken } from '../schemas/oauth.schema.js';
import { registrarParserDeFormulario } from './form-body.js';
import { registrarTratadorDeErro } from './oauth-error-handler.js';
import { LIMITE_TOKEN } from '../hooks/token-rate-limit.js';
import { ErroDeOAuth } from '../errors/oauth-error.js';
import type { HooksDeLimite } from '../../../shared/rate-limit/hook-por-identidade.js';

export interface DependenciasDasRotasDeOAuth extends DependenciasDoControllerDeOAuth {
  /**
   * Limite por cliente. Ausente, vale só o limite por IP — e um cliente com muitos IPs
   * varreria segredo sem tocar em teto nenhum.
   */
  readonly limitePorCliente?: HooksDeLimite;
}

const TIPO_ESPERADO = 'application/x-www-form-urlencoded';

export async function registrarRotasDeOAuth(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeOAuth,
): Promise<void> {
  await app.register((escopo, _opcoes, pronto) => {
    registrarParserDeFormulario(escopo);
    registrarTratadorDeErro(escopo);

    escopo.addHook('onRequest', (requisicao, _resposta, feito) => {
      const tipo = requisicao.headers['content-type'] ?? '';
      if (!tipo.toLowerCase().startsWith(TIPO_ESPERADO)) {
        feito(new ErroDeOAuth('invalid_request', `Use ${TIPO_ESPERADO}.`));
        return;
      }
      feito();
    });

    const tipado = escopo.withTypeProvider<ZodTypeProvider>();
    const controller = criarControllerDeOAuth({ oauthService: deps.oauthService });

    tipado.post(
      '/oauth/token',
      {
        schema: {
          tags: ['oauth'],
          summary: 'Emite um access token pelos grants da RFC 6749',
          body: corpoDeToken,
          response: { 200: respostaDeToken, 400: erroDeOAuth, 401: erroDeOAuth },
        },
        config: { rateLimit: LIMITE_TOKEN },
        // O limite por IP roda no plugin, antes do corpo; o por cliente precisa do
        // `client_id`, que vem do header Basic ou do formulário já parseado.
        ...(deps.limitePorCliente === undefined
          ? {}
          : {
              preHandler: deps.limitePorCliente.preHandler,
              onResponse: deps.limitePorCliente.onResponse,
            }),
      },
      (requisicao, resposta) => controller.token(requisicao, resposta),
    );

    pronto();
  });
}
