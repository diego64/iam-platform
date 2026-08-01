/**
 * Responsabilidade: registrar as 3 rotas de autenticação com validação Zod e tags OpenAPI.
 * Regras: recebe o AuthService e o verificador de token por injeção; não conhece banco.
 * `/auth/login` é público e com rate limit; `/auth/logout` e `/auth/me` exigem Bearer e
 * passam pelo preHandler que popula `request.usuario`.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeAuth,
  type DependenciasDoControllerDeAuth,
} from '../controllers/auth.controller.js';
import type { VerificadorDeAccessToken } from '../middleware/verify-access-token.js';
import { loginBody, logoutBody, respostaLogin, respostaMe } from '../schemas/auth.schema.js';
import { LIMITE_LOGIN } from '../hooks/login-rate-limit.js';

export interface DependenciasDasRotasDeAuth extends DependenciasDoControllerDeAuth {
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

export function registrarRotasDeAuth(app: FastifyInstance, deps: DependenciasDasRotasDeAuth): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeAuth({ authService: deps.authService });
  const seguranca = [{ BearerAuth: [] }];

  tipado.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Autentica e-mail + senha e emite os tokens',
        body: loginBody,
        response: { 200: respostaLogin },
      },
      config: { rateLimit: LIMITE_LOGIN },
    },
    (requisicao, resposta) => controller.login(requisicao, resposta),
  );

  tipado.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoga o par de tokens (denylist + refresh)',
        security: seguranca,
        body: logoutBody,
      },
      preHandler: deps.verificarAccessToken,
    },
    (requisicao, resposta) => controller.logout(requisicao, resposta),
  );

  tipado.get(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Perfil do usuário autenticado',
        security: seguranca,
        response: { 200: respostaMe },
      },
      preHandler: deps.verificarAccessToken,
    },
    (requisicao, resposta) => controller.eu(requisicao, resposta),
  );
}
