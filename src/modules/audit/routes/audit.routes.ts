/**
 * Responsabilidade: registrar as rotas de leitura da trilha com validação Zod, tags OpenAPI
 * e os guards de autorização.
 * Regras:
 *  - Toda rota passa primeiro por `verificarAccessToken` (autentica) e depois pelo guard
 *    (autoriza). Ler a trilha exige `audit:read`; verificá-la exige `audit:verify`, porque
 *    a varredura é cara e o resultado é uma afirmação sobre a própria auditoria.
 *  - Não existe rota de escrita. O `POST` declarado responde 405 de propósito: a recusa
 *    fica no contrato, em vez de virar um 404 que parece esquecimento.
 *  - Recebe serviços, guards e verificador por injeção; não conhece banco.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeAuditoria,
  type DependenciasDoControllerDeAuditoria,
} from '../controllers/audit.controller.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import { LIMITE_LEITURA, LIMITE_VERIFICACAO } from '../hooks/audit-rate-limit.js';
import {
  eventoDetalheResposta,
  eventoParams,
  integridadeQuery,
  listaDeEventosResposta,
  listarEventosQuery,
  relatorioDeIntegridadeResposta,
} from '../schemas/audit.schema.js';

export interface DependenciasDasRotasDeAuditoria extends DependenciasDoControllerDeAuditoria {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeAuditoria(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeAuditoria,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeAuditoria(deps);
  const { exigirPermissao } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  tipado.get(
    '/audit/events',
    {
      schema: {
        tags: ['audit'],
        summary: 'Lista eventos da trilha de auditoria',
        security: seguranca,
        querystring: listarEventosQuery,
        response: { 200: listaDeEventosResposta },
      },
      config: { rateLimit: LIMITE_LEITURA },
      preHandler: [auth, exigirPermissao('audit:read')],
    },
    (req, resp) => controller.listar(req, resp),
  );

  tipado.get(
    '/audit/events/:seq',
    {
      schema: {
        tags: ['audit'],
        summary: 'Obtém um evento pela posição na cadeia',
        security: seguranca,
        params: eventoParams,
        response: { 200: eventoDetalheResposta },
      },
      config: { rateLimit: LIMITE_LEITURA },
      preHandler: [auth, exigirPermissao('audit:read')],
    },
    (req, resp) => controller.obter(req, resp),
  );

  tipado.get(
    '/audit/integrity',
    {
      schema: {
        tags: ['audit'],
        summary: 'Verifica a integridade da cadeia numa faixa',
        security: seguranca,
        querystring: integridadeQuery,
        response: { 200: relatorioDeIntegridadeResposta },
      },
      config: { rateLimit: LIMITE_VERIFICACAO },
      preHandler: [auth, exigirPermissao('audit:verify')],
    },
    (req, resp) => controller.verificar(req, resp),
  );

  tipado.post(
    '/audit/events',
    {
      schema: {
        tags: ['audit'],
        summary: 'Recusa escrita externa na trilha',
        security: seguranca,
      },
      config: { rateLimit: LIMITE_LEITURA },
      preHandler: [auth, exigirPermissao('audit:read')],
    },
    (req, resp) => controller.recusarEscrita(req, resp),
  );
}
