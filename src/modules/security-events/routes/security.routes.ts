/**
 * Responsabilidade: registrar as duas rotas de leitura dos eventos de segurança.
 * Regras: ambas exigem access token e a permissão `security:read`. Não há rota de escrita —
 * evento de segurança é produzido de dentro do processo, como a trilha da SPEC 013.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeSeguranca,
  type DependenciasDoControllerDeSeguranca,
} from '../controllers/security.controller.js';
import {
  consultaDeEventos,
  eventoDeSegurancaDto,
  listaDeEventos,
  parametroDeEvento,
} from '../schemas/security.schema.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';

export interface DependenciasDasRotasDeSeguranca extends DependenciasDoControllerDeSeguranca {
  readonly verificarAccessToken: VerificadorDeAccessToken;
  readonly guards: GuardsDeAutorizacao;
}

export function registrarRotasDeSeguranca(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeSeguranca,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeSeguranca(deps);
  const seguranca = [{ BearerAuth: [] }];
  const exigir = [deps.verificarAccessToken, deps.guards.exigirPermissao('security:read')];

  tipado.get(
    '/security/events',
    {
      schema: {
        tags: ['security'],
        summary: 'Lista os eventos de segurança detectados',
        security: seguranca,
        querystring: consultaDeEventos,
        response: { 200: listaDeEventos },
      },
      preHandler: exigir,
    },
    (requisicao, resposta) => controller.listar(requisicao, resposta),
  );

  tipado.get(
    '/security/events/:id',
    {
      schema: {
        tags: ['security'],
        summary: 'Detalha um evento de segurança',
        security: seguranca,
        params: parametroDeEvento,
        response: { 200: eventoDeSegurancaDto },
      },
      preHandler: exigir,
    },
    (requisicao, resposta) => controller.obter(requisicao, resposta),
  );
}
