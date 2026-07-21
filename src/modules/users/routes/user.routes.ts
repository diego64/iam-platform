/**
 * Responsabilidade: registrar as 7 rotas de usuário com validação Zod e tags de OpenAPI.
 * Regras: recebe o controller (com serviço, autorizador e medidor) por injeção; não conhece
 * banco. Toda rota declara `BearerAuth` — a autorização real roda no controller.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeUsuario,
  type DependenciasDoController,
} from '../controllers/user.controller.js';
import {
  atualizarUsuarioBody,
  criarUsuarioBody,
  idParams,
  listarUsuariosQuery,
} from '../schemas/user.schema.js';
import { LIMITE_ADMIN, LIMITE_CRIACAO } from '../hooks/users-rate-limit.js';

export function registrarRotasDeUsuario(
  app: FastifyInstance,
  deps: DependenciasDoController,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeUsuario(deps);
  const seguranca = [{ BearerAuth: [] }];

  tipado.post(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Cria um usuário (admin)',
        security: seguranca,
        body: criarUsuarioBody,
      },
      config: { rateLimit: LIMITE_CRIACAO },
    },
    (requisicao, resposta) => controller.criar(requisicao, resposta),
  );

  tipado.get(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Lista usuários com paginação e filtro de status (admin)',
        security: seguranca,
        querystring: listarUsuariosQuery,
      },
    },
    (requisicao, resposta) => controller.listar(requisicao, resposta),
  );

  tipado.get(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Busca um usuário por id (admin)',
        security: seguranca,
        params: idParams,
      },
    },
    (requisicao, resposta) => controller.obter(requisicao, resposta),
  );

  tipado.patch(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Atualiza o e-mail de um usuário (admin)',
        security: seguranca,
        params: idParams,
        body: atualizarUsuarioBody,
      },
      config: { rateLimit: LIMITE_ADMIN },
    },
    (requisicao, resposta) => controller.atualizar(requisicao, resposta),
  );

  tipado.post(
    '/users/:id/block',
    {
      schema: {
        tags: ['users'],
        summary: 'Bloqueia um usuário e revoga suas sessões (admin)',
        security: seguranca,
        params: idParams,
      },
      config: { rateLimit: LIMITE_ADMIN },
    },
    (requisicao, resposta) => controller.bloquear(requisicao, resposta),
  );

  tipado.post(
    '/users/:id/unblock',
    {
      schema: {
        tags: ['users'],
        summary: 'Desbloqueia um usuário (admin)',
        security: seguranca,
        params: idParams,
      },
      config: { rateLimit: LIMITE_ADMIN },
    },
    (requisicao, resposta) => controller.desbloquear(requisicao, resposta),
  );

  tipado.delete(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Remove um usuário e revoga suas sessões (admin)',
        security: seguranca,
        params: idParams,
      },
      config: { rateLimit: LIMITE_ADMIN },
    },
    (requisicao, resposta) => controller.remover(requisicao, resposta),
  );
}
