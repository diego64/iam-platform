/**
 * Responsabilidade: registrar as 4 rotas de senha com validação Zod e tags de OpenAPI.
 * Regras: recebe o serviço e o autenticador por injeção; não conhece banco.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeSenha,
  type DependenciasDoController,
} from '../controllers/password.controller.js';
import { esqueciSenhaBody, resetSenhaBody, trocarSenhaBody } from '../schemas/password.schema.js';

export function registrarRotasDeSenha(app: FastifyInstance, deps: DependenciasDoController): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();
  const controller = criarControllerDeSenha(deps);

  tipado.post(
    '/auth/password/change',
    {
      schema: {
        tags: ['password'],
        summary: 'Troca a senha (autenticado, exige a senha atual)',
        security: [{ BearerAuth: [] }],
        body: trocarSenhaBody,
      },
    },
    (requisicao, resposta) => controller.trocar(requisicao, resposta),
  );

  tipado.post(
    '/auth/password/forgot',
    {
      schema: {
        tags: ['password'],
        summary: 'Solicita a recuperação de senha (responde 202 sempre)',
        security: [],
        body: esqueciSenhaBody,
      },
    },
    (requisicao, resposta) => controller.esqueci(requisicao, resposta),
  );

  tipado.post(
    '/auth/password/reset',
    {
      schema: {
        tags: ['password'],
        summary: 'Redefine a senha a partir de um token de reset',
        security: [],
        body: resetSenhaBody,
      },
    },
    (requisicao, resposta) => controller.reset(requisicao, resposta),
  );

  tipado.get(
    '/auth/password/policy',
    {
      schema: {
        tags: ['password'],
        summary: 'Regras vigentes de força de senha',
        security: [],
      },
    },
    (requisicao, resposta) => {
      controller.politica(requisicao, resposta);
    },
  );
}
