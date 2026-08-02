/**
 * Responsabilidade: registrar as rotas administrativas de chaves com validação Zod, tags
 * OpenAPI e os guards de autorização.
 * Regras:
 *  - Toda rota passa primeiro por `verificarAccessToken` (autentica) e depois pelo guard
 *    (autoriza). Leitura exige `keys:read`; preparar e promover exigem `keys:write`.
 *  - Revogar exige o **papel** `superadmin`, não a permissão de escrita: encerrar uma chave
 *    invalida de uma vez todos os tokens que ela assinou, o que derruba a sessão de todos os
 *    usuários. É o mesmo patamar das operações de concessão de papel.
 *  - Recebe serviços, guards e verificador por injeção; não conhece banco.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeChaves,
  type DependenciasDoControllerDeChaves,
} from '../controllers/keys-admin.controller.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import {
  kidParams,
  listarChavesQuery,
  respostaChavePreparada,
  respostaListaDeChaves,
  respostaRevogacao,
  respostaRotacao,
  revogarBody,
  rotacionarBody,
} from '../schemas/keys-admin.schema.js';

export interface DependenciasDasRotasDeChaves extends DependenciasDoControllerDeChaves {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeChaves(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeChaves,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeChaves(deps);
  const { exigirPermissao, exigirPapel } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  tipado.get(
    '/admin/keys',
    {
      schema: {
        tags: ['keys'],
        summary: 'Lista os metadados das chaves de assinatura',
        security: seguranca,
        querystring: listarChavesQuery,
        response: { 200: respostaListaDeChaves },
      },
      preHandler: [auth, exigirPermissao('keys:read')],
    },
    (req, resp) => controller.listar(req, resp),
  );

  tipado.post(
    '/admin/keys/prepare',
    {
      schema: {
        tags: ['keys'],
        summary: 'Gera e publica a próxima chave (idempotente)',
        security: seguranca,
        response: { 200: respostaChavePreparada, 201: respostaChavePreparada },
      },
      preHandler: [auth, exigirPermissao('keys:write')],
    },
    (req, resp) => controller.preparar(req, resp),
  );

  tipado.post(
    '/admin/keys/rotate',
    {
      schema: {
        tags: ['keys'],
        summary: 'Promove a chave pré-publicada e aposenta a ativa',
        security: seguranca,
        body: rotacionarBody,
        response: { 200: respostaRotacao },
      },
      preHandler: [auth, exigirPermissao('keys:write')],
    },
    (req, resp) => controller.rotacionar(req, resp),
  );

  tipado.post(
    '/admin/keys/:kid/revoke',
    {
      schema: {
        tags: ['keys'],
        summary: 'Revoga uma chave imediatamente (superadmin)',
        security: seguranca,
        params: kidParams,
        body: revogarBody,
        response: { 200: respostaRevogacao },
      },
      preHandler: [auth, exigirPapel('superadmin')],
    },
    (req, resp) => controller.revogar(req, resp),
  );
}
