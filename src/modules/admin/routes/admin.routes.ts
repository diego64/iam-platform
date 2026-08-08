/**
 * Responsabilidade: registrar as rotas do painel com validação Zod, tags OpenAPI e os guards.
 * Regras:
 *  - Toda rota tem `verificarAccessToken` e um guard. Não é convenção: a barreira de boot
 *    recusa subir o processo se alguma faltar.
 *  - Leitura agregada exige `admin:read`; listar sessão de terceiro, `sessions:read`;
 *    encerrar, `sessions:revoke`. São privilégios diferentes de propósito — ver a sessão de
 *    alguém e derrubá-la não são a mesma decisão.
 *  - Este módulo não reimplementa o que já existe: criar usuário, papel, cliente ou chave
 *    continua nas rotas dos módulos donos, e o painel as consome.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeAdmin,
  type DependenciasDoControllerDeAdmin,
} from '../controllers/admin.controller.js';
import type { GuardsDeAutorizacao } from '../../rbac/middleware/require-permission.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';
import { LIMITE_ADMINISTRATIVO } from '../hooks/admin-rate-limit.js';
import {
  fichaDeUsuarioResposta,
  listaDeSessoesResposta,
  revogacaoEmMassaResposta,
  sessaoParams,
  usuarioParams,
  visaoGeralResposta,
} from '../schemas/admin.schema.js';

export interface DependenciasDasRotasDeAdmin extends DependenciasDoControllerDeAdmin {
  readonly guards: GuardsDeAutorizacao;
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeAdmin(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeAdmin,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeAdmin(deps);
  const { exigirPermissao } = deps.guards;
  const auth = deps.verificarAccessToken;
  const seguranca = [{ BearerAuth: [] }];

  tipado.get(
    '/admin/overview',
    {
      schema: {
        tags: ['admin'],
        summary: 'Números da tela inicial do painel',
        security: seguranca,
        response: { 200: visaoGeralResposta },
      },
      config: { rateLimit: LIMITE_ADMINISTRATIVO },
      preHandler: [auth, exigirPermissao('admin:read')],
    },
    (req, resp) => controller.visaoGeral(req, resp),
  );

  tipado.get(
    '/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Ficha completa de um usuário',
        security: seguranca,
        params: usuarioParams,
        response: { 200: fichaDeUsuarioResposta },
      },
      config: { rateLimit: LIMITE_ADMINISTRATIVO },
      preHandler: [auth, exigirPermissao('admin:read')],
    },
    (req, resp) => controller.fichaDeUsuario(req, resp),
  );

  tipado.get(
    '/admin/users/:id/sessions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Sessões ativas de um usuário',
        security: seguranca,
        params: usuarioParams,
        response: { 200: listaDeSessoesResposta },
      },
      config: { rateLimit: LIMITE_ADMINISTRATIVO },
      preHandler: [auth, exigirPermissao('sessions:read')],
    },
    (req, resp) => controller.listarSessoes(req, resp),
  );

  tipado.delete(
    '/admin/users/:id/sessions/:sessionId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Encerra uma sessão de um usuário',
        security: seguranca,
        params: sessaoParams,
      },
      config: { rateLimit: LIMITE_ADMINISTRATIVO },
      preHandler: [auth, exigirPermissao('sessions:revoke')],
    },
    (req, resp) => controller.revogarSessao(req, resp),
  );

  tipado.delete(
    '/admin/users/:id/sessions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Encerra todas as sessões de um usuário',
        security: seguranca,
        params: usuarioParams,
        response: { 200: revogacaoEmMassaResposta },
      },
      config: { rateLimit: LIMITE_ADMINISTRATIVO },
      preHandler: [auth, exigirPermissao('sessions:revoke')],
    },
    (req, resp) => controller.revogarSessoes(req, resp),
  );
}
