/**
 * Responsabilidade: registrar as rotas do segundo fator com validação Zod e tags de OpenAPI.
 * Regras:
 *  - Cinco exigem access token; `/auth/mfa/verify` não, porque o `mfa_token` é a credencial
 *    dela — quem está ali ainda não tem token nenhum.
 *  - O escopo encapsulado aplica o verificador a todas menos a de verificação, em vez de
 *    repetir o hook rota a rota (e esquecer numa).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  criarControllerDeMfa,
  type DependenciasDoControllerDeMfa,
} from '../controllers/mfa.controller.js';
import {
  cadastroBody,
  confirmacaoBody,
  respostaDeCadastro,
  respostaDeCodigos,
  respostaDeConfirmacao,
  respostaDeEstado,
  respostaDeTokens,
  stepUpBody,
  verificacaoBody,
} from '../schemas/mfa.schema.js';
import { LIMITE_VERIFICACAO } from '../hooks/mfa-rate-limit.js';
import type { VerificadorDeAccessToken } from '../../auth/middleware/verify-access-token.js';

export interface DependenciasDasRotasDeMfa extends DependenciasDoControllerDeMfa {
  readonly verificarAccessToken: VerificadorDeAccessToken;
}

/** A única rota do módulo que não exige access token. */
const ROTA_DE_VERIFICACAO = '/auth/mfa/verify';

export async function registrarRotasDeMfa(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeMfa,
): Promise<void> {
  await app.register((escopo, _opcoes, pronto) => {
    escopo.addHook('preHandler', async (requisicao, resposta) => {
      if (requisicao.routeOptions.url !== ROTA_DE_VERIFICACAO) {
        await deps.verificarAccessToken(requisicao, resposta);
      }
    });

    const tipado = escopo.withTypeProvider<ZodTypeProvider>();
    const controller = criarControllerDeMfa(deps);

    tipado.get(
      '/auth/mfa',
      {
        schema: {
          tags: ['mfa'],
          summary: 'Estado do segundo fator do usuário autenticado',
          security: [{ BearerAuth: [] }],
          response: { 200: respostaDeEstado },
        },
      },
      (requisicao, resposta) => controller.estado(requisicao, resposta),
    );

    tipado.post(
      '/auth/mfa/totp',
      {
        schema: {
          tags: ['mfa'],
          summary: 'Inicia o cadastro de TOTP e devolve o segredo uma única vez',
          security: [{ BearerAuth: [] }],
          body: cadastroBody,
          response: { 201: respostaDeCadastro },
        },
      },
      (requisicao, resposta) => controller.iniciar(requisicao, resposta),
    );

    tipado.post(
      '/auth/mfa/totp/confirm',
      {
        schema: {
          tags: ['mfa'],
          summary: 'Ativa o fator e entrega os códigos de recuperação',
          security: [{ BearerAuth: [] }],
          body: confirmacaoBody,
          response: { 200: respostaDeConfirmacao },
        },
      },
      (requisicao, resposta) => controller.confirmar(requisicao, resposta),
    );

    tipado.delete(
      '/auth/mfa/totp',
      {
        schema: {
          tags: ['mfa'],
          summary: 'Desativa o segundo fator (exige a senha atual)',
          security: [{ BearerAuth: [] }],
          body: stepUpBody,
        },
      },
      (requisicao, resposta) => controller.desativar(requisicao, resposta),
    );

    tipado.post(
      '/auth/mfa/recovery-codes',
      {
        schema: {
          tags: ['mfa'],
          summary: 'Regenera os códigos de recuperação (exige a senha atual)',
          security: [{ BearerAuth: [] }],
          body: stepUpBody,
          response: { 200: respostaDeCodigos },
        },
      },
      (requisicao, resposta) => controller.regenerar(requisicao, resposta),
    );

    tipado.post(
      ROTA_DE_VERIFICACAO,
      {
        schema: {
          tags: ['mfa'],
          summary: 'Responde ao desafio e emite o par de tokens',
          security: [],
          body: verificacaoBody,
          response: { 200: respostaDeTokens },
        },
        config: { rateLimit: LIMITE_VERIFICACAO },
      },
      (requisicao, resposta) => controller.verificar(requisicao, resposta),
    );

    pronto();
  });
}
