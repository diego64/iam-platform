/**
 * Responsabilidade: registrar a rota de teste de entrega.
 * Regras:
 *  - Exige access token e a permissão `notifications:send`: a rota gasta cota do provedor e
 *    manda e-mail de verdade.
 *  - Limite apertado — três por minuto. Ela é uma ferramenta de diagnóstico, não um canal.
 *  - Não existe rota de envio arbitrário nem de histórico. A primeira seria relay de spam
 *    autenticado; a segunda exigiria persistir o que saiu, que esta SPEC decidiu não fazer.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeNotificacoes,
  type DependenciasDoControllerDeNotificacoes,
} from '../controllers/notifications.controller.js';
import { corpoDoTeste, resultadoDoTeste } from '../schemas/notifications.schema.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';

/** Diagnóstico, não canal: três por minuto é o suficiente para conferir e não para abusar. */
export const LIMITE_TESTE = { max: 3, timeWindow: '1 minute' } as const;

export interface DependenciasDasRotasDeNotificacoes extends DependenciasDoControllerDeNotificacoes {
  readonly verificarAccessToken: VerificadorDeAccessToken;
  readonly guards: GuardsDeAutorizacao;
}

export function registrarRotasDeNotificacoes(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeNotificacoes,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeNotificacoes(deps);

  tipado.post(
    '/notifications/test',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Envia a mensagem de verificação aos endereços de operação',
        security: [{ BearerAuth: [] }],
        body: corpoDoTeste,
        response: { 200: resultadoDoTeste },
      },
      config: { rateLimit: LIMITE_TESTE },
      onRequest: deps.verificarAccessToken,
      preHandler: deps.guards.exigirPermissao('notifications:send'),
    },
    (requisicao, resposta) => controller.testar(requisicao, resposta),
  );
}
