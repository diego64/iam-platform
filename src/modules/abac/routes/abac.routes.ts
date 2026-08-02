/**
 * Responsabilidade: registrar as rotas do ABAC com validação Zod, tags OpenAPI e os guards
 * de autorização do RBAC.
 * Regras:
 *  - Toda rota passa primeiro por `verificarAccessToken` (autentica) e depois por
 *    `exigirPermissao` (autoriza). Nenhuma escrita sem `policies:write`/`policies:delete`.
 *  - O simulador exige `policies:read`: ele revela quais políticas decidem o quê, então não
 *    é endpoint público mesmo não tendo efeito colateral.
 *  - Recebe serviços, guards e verificador por injeção; não conhece banco.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeAbac,
  type DependenciasDoControllerDeAbac,
} from '../controllers/abac.controller.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import {
  atualizarPoliticaBody,
  avaliarBody,
  criarPoliticaBody,
  idParams,
  listarPoliticasQuery,
  respostaDecisao,
  respostaListaPoliticas,
  respostaPolitica,
  respostaPoliticaDetalhe,
} from '../schemas/policy.schema.js';

export interface DependenciasDasRotasDeAbac extends DependenciasDoControllerDeAbac {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeAbac(app: FastifyInstance, deps: DependenciasDasRotasDeAbac): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeAbac(deps);
  const { exigirPermissao } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  tipado.post(
    '/policies',
    {
      schema: {
        tags: ['abac'],
        summary: 'Cria uma política',
        security: seguranca,
        body: criarPoliticaBody,
        response: { 201: respostaPolitica },
      },
      preHandler: [auth, exigirPermissao('policies:write')],
    },
    (req, resp) => controller.criarPolitica(req, resp),
  );

  tipado.get(
    '/policies',
    {
      schema: {
        tags: ['abac'],
        summary: 'Lista políticas com filtro e paginação',
        security: seguranca,
        querystring: listarPoliticasQuery,
        response: { 200: respostaListaPoliticas },
      },
      preHandler: [auth, exigirPermissao('policies:read')],
    },
    (req, resp) => controller.listarPoliticas(req, resp),
  );

  tipado.get(
    '/policies/:id',
    {
      schema: {
        tags: ['abac'],
        summary: 'Detalha uma política, incluindo a condição',
        security: seguranca,
        params: idParams,
        response: { 200: respostaPoliticaDetalhe },
      },
      preHandler: [auth, exigirPermissao('policies:read')],
    },
    (req, resp) => controller.obterPolitica(req, resp),
  );

  tipado.patch(
    '/policies/:id',
    {
      schema: {
        tags: ['abac'],
        summary: 'Atualiza uma política',
        security: seguranca,
        params: idParams,
        body: atualizarPoliticaBody,
        response: { 200: respostaPolitica },
      },
      preHandler: [auth, exigirPermissao('policies:write')],
    },
    (req, resp) => controller.atualizarPolitica(req, resp),
  );

  tipado.delete(
    '/policies/:id',
    {
      schema: {
        tags: ['abac'],
        summary: 'Remove uma política',
        security: seguranca,
        params: idParams,
      },
      preHandler: [auth, exigirPermissao('policies:delete')],
    },
    (req, resp) => controller.removerPolitica(req, resp),
  );

  // Simulação: decide sem enforcement, sobre atributos informados pelo chamador.
  tipado.post(
    '/policies/evaluate',
    {
      schema: {
        tags: ['abac'],
        summary: 'Avalia uma decisão de política (PDP online)',
        security: seguranca,
        body: avaliarBody,
        response: { 200: respostaDecisao },
      },
      preHandler: [auth, exigirPermissao('policies:read')],
    },
    (req, resp) => controller.avaliar(req, resp),
  );
}
