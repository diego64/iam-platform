/**
 * Responsabilidade: registrar as rotas do RBAC com validação Zod, tags OpenAPI e os guards
 * de autorização.
 * Regras:
 *  - Toda rota passa primeiro por `verificarAccessToken` (autentica) e depois pelo guard
 *    (autoriza). Escrita de vínculo usuário↔papel exige o papel `superadmin` (RF-09); o
 *    resto exige a permissão do recurso.
 *  - Recebe serviços, guards e verificador por injeção; não conhece banco.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeRbac,
  type DependenciasDoControllerDeRbac,
} from '../controllers/rbac.controller.js';
import type { GuardsDeAutorizacao } from '../middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import {
  associarPermissoesBody,
  atribuirPapeisBody,
  atualizarPapelBody,
  criarPapelBody,
  criarPermissaoBody,
  idParams,
  paginacaoQuery,
  respostaListaPapeis,
  respostaListaPermissoes,
  respostaPapeisDoUsuario,
  respostaPapel,
  respostaPapelDetalhe,
  respostaPermissao,
  roleComPermissaoParams,
  userComPapelParams,
} from '../schemas/rbac.schema.js';

export interface DependenciasDasRotasDeRbac extends DependenciasDoControllerDeRbac {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeRbac(app: FastifyInstance, deps: DependenciasDasRotasDeRbac): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeRbac(deps);
  const { exigirPermissao, exigirPapel } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  // ----- Papéis -----
  tipado.post(
    '/roles',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Cria um papel',
        security: seguranca,
        body: criarPapelBody,
        response: { 201: respostaPapel },
      },
      preHandler: [auth, exigirPermissao('roles:write')],
    },
    (req, resp) => controller.criarPapel(req, resp),
  );

  tipado.get(
    '/roles',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Lista papéis com paginação',
        security: seguranca,
        querystring: paginacaoQuery,
        response: { 200: respostaListaPapeis },
      },
      preHandler: [auth, exigirPermissao('roles:read')],
    },
    (req, resp) => controller.listarPapeis(req, resp),
  );

  tipado.get(
    '/roles/:id',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Detalha um papel e suas permissões',
        security: seguranca,
        params: idParams,
        response: { 200: respostaPapelDetalhe },
      },
      preHandler: [auth, exigirPermissao('roles:read')],
    },
    (req, resp) => controller.obterPapel(req, resp),
  );

  tipado.patch(
    '/roles/:id',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Renomeia/atualiza um papel',
        security: seguranca,
        params: idParams,
        body: atualizarPapelBody,
        response: { 200: respostaPapel },
      },
      preHandler: [auth, exigirPermissao('roles:write')],
    },
    (req, resp) => controller.atualizarPapel(req, resp),
  );

  tipado.delete(
    '/roles/:id',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Remove um papel',
        security: seguranca,
        params: idParams,
      },
      preHandler: [auth, exigirPermissao('roles:delete')],
    },
    (req, resp) => controller.removerPapel(req, resp),
  );

  // ----- Associação papel ↔ permissões -----
  tipado.post(
    '/roles/:id/permissions',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Associa permissões a um papel',
        security: seguranca,
        params: idParams,
        body: associarPermissoesBody,
      },
      preHandler: [auth, exigirPermissao('roles:write')],
    },
    (req, resp) => controller.associarPermissoes(req, resp),
  );

  tipado.delete(
    '/roles/:id/permissions/:permId',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Desassocia uma permissão de um papel',
        security: seguranca,
        params: roleComPermissaoParams,
      },
      preHandler: [auth, exigirPermissao('roles:write')],
    },
    (req, resp) => controller.desassociarPermissao(req, resp),
  );

  // ----- Permissões -----
  tipado.post(
    '/permissions',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Cria uma permissão',
        security: seguranca,
        body: criarPermissaoBody,
        response: { 201: respostaPermissao },
      },
      preHandler: [auth, exigirPermissao('permissions:write')],
    },
    (req, resp) => controller.criarPermissao(req, resp),
  );

  tipado.get(
    '/permissions',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Lista permissões com paginação',
        security: seguranca,
        querystring: paginacaoQuery,
        response: { 200: respostaListaPermissoes },
      },
      preHandler: [auth, exigirPermissao('permissions:read')],
    },
    (req, resp) => controller.listarPermissoes(req, resp),
  );

  tipado.delete(
    '/permissions/:id',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Remove uma permissão',
        security: seguranca,
        params: idParams,
      },
      preHandler: [auth, exigirPermissao('permissions:delete')],
    },
    (req, resp) => controller.removerPermissao(req, resp),
  );

  // ----- Vínculo usuário ↔ papéis (escrita: só superadmin, RF-09) -----
  tipado.get(
    '/users/:id/roles',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Lista os papéis de um usuário',
        security: seguranca,
        params: idParams,
        response: { 200: respostaPapeisDoUsuario },
      },
      preHandler: [auth, exigirPermissao('roles:read')],
    },
    (req, resp) => controller.listarPapeisDoUsuario(req, resp),
  );

  tipado.post(
    '/users/:id/roles',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Atribui papéis a um usuário (superadmin)',
        security: seguranca,
        params: idParams,
        body: atribuirPapeisBody,
      },
      preHandler: [auth, exigirPapel('superadmin')],
    },
    (req, resp) => controller.atribuirPapeis(req, resp),
  );

  tipado.delete(
    '/users/:id/roles/:roleId',
    {
      schema: {
        tags: ['rbac'],
        summary: 'Revoga um papel de um usuário (superadmin)',
        security: seguranca,
        params: userComPapelParams,
      },
      preHandler: [auth, exigirPapel('superadmin')],
    },
    (req, resp) => controller.desatribuirPapel(req, resp),
  );
}
