/**
 * Responsabilidade: registrar as rotas de clientes de API com validação Zod, tags OpenAPI e
 * os guards de autorização.
 * Regras:
 *  - Toda rota passa primeiro por `verificarAccessToken` (autentica) e depois pelo guard.
 *  - **Autoridade dividida.** Criar cliente e alterar seus escopos ou grants exigem o papel
 *    `superadmin`: conceder escopo é conceder privilégio, e quem pudesse editá-lo criaria um
 *    cliente com autoridade que ele próprio não tem, e usaria o token dele. O que não
 *    concede privilégio — rotacionar segredo, desabilitar, corrigir nome — fica em
 *    `clients:write`, porque é operação de incidente e não pode depender do superadmin.
 *  - No `PATCH` a autoridade depende do corpo, então o guard é escolhido por requisição.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeClientes,
  type DependenciasDoControllerDeClientes,
} from '../controllers/api-client.controller.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import {
  atualizarClienteBody,
  CAMPOS_PRIVILEGIADOS,
  criarClienteBody,
  idParams,
  listarClientesQuery,
  respostaClienteCriado,
  respostaListaDeClientes,
  respostaSegredoRotacionado,
  rotacionarSegredoBody,
  clienteDto,
} from '../schemas/api-client.schema.js';

export interface DependenciasDasRotasDeClientes extends DependenciasDoControllerDeClientes {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeClientes(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeClientes,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeClientes(deps);
  const { exigirPermissao, exigirPapel } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  const soSuperadmin = exigirPapel('superadmin');
  const podeEscrever = exigirPermissao('clients:write');

  /**
   * Escolhe o guard pelo conteúdo do corpo: qualquer campo privilegiado presente eleva a
   * requisição inteira ao `superadmin`.
   *
   * O corpo misto é intencionalmente tratado como privilegiado, e não dividido em duas
   * aplicações parciais: aplicar só a parte operacional deixaria o chamador achando que a
   * alteração toda passou. É 403 sem aplicar nada.
   */
  async function autoridadeDoPatch(req: FastifyRequest, resp: FastifyReply): Promise<void> {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const privilegiado = CAMPOS_PRIVILEGIADOS.some((campo) => campo in corpo);
    await (privilegiado ? soSuperadmin(req, resp) : podeEscrever(req, resp));
  }

  tipado.post(
    '/clients',
    {
      schema: {
        tags: ['clients'],
        summary: 'Cria um cliente de API (superadmin)',
        security: seguranca,
        body: criarClienteBody,
        response: { 201: respostaClienteCriado },
      },
      preHandler: [auth, soSuperadmin],
    },
    (req, resp) => controller.criar(req, resp),
  );

  tipado.get(
    '/clients',
    {
      schema: {
        tags: ['clients'],
        summary: 'Lista clientes de API com paginação',
        security: seguranca,
        querystring: listarClientesQuery,
        response: { 200: respostaListaDeClientes },
      },
      preHandler: [auth, exigirPermissao('clients:read')],
    },
    (req, resp) => controller.listar(req, resp),
  );

  tipado.get(
    '/clients/:id',
    {
      schema: {
        tags: ['clients'],
        summary: 'Detalha um cliente de API',
        security: seguranca,
        params: idParams,
        response: { 200: clienteDto },
      },
      preHandler: [auth, exigirPermissao('clients:read')],
    },
    (req, resp) => controller.obter(req, resp),
  );

  tipado.patch(
    '/clients/:id',
    {
      schema: {
        tags: ['clients'],
        summary: 'Altera um cliente (escopos e grants exigem superadmin)',
        security: seguranca,
        params: idParams,
        body: atualizarClienteBody,
        response: { 200: clienteDto },
      },
      preHandler: [auth, autoridadeDoPatch],
    },
    (req, resp) => controller.atualizar(req, resp),
  );

  tipado.delete(
    '/clients/:id',
    {
      schema: {
        tags: ['clients'],
        summary: 'Remove um cliente (remoção lógica)',
        security: seguranca,
        params: idParams,
      },
      preHandler: [auth, exigirPermissao('clients:delete')],
    },
    (req, resp) => controller.remover(req, resp),
  );

  tipado.post(
    '/clients/:id/secret',
    {
      schema: {
        tags: ['clients'],
        summary: 'Rotaciona o segredo mantendo o anterior aceito por uma janela',
        security: seguranca,
        params: idParams,
        body: rotacionarSegredoBody,
        response: { 200: respostaSegredoRotacionado },
      },
      preHandler: [auth, podeEscrever],
    },
    (req, resp) => controller.rotacionarSegredo(req, resp),
  );

  tipado.post(
    '/clients/:id/secret/revoke-previous',
    {
      schema: {
        tags: ['clients'],
        summary: 'Encerra a sobreposição de segredo imediatamente',
        security: seguranca,
        params: idParams,
      },
      preHandler: [auth, podeEscrever],
    },
    (req, resp) => controller.revogarSegredoAnterior(req, resp),
  );
}
