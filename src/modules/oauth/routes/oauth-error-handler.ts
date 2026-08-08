/**
 * Responsabilidade: traduzir qualquer erro das rotas de OAuth para o formato da RFC 6749 §5.2.
 * Consumido por: o escopo encapsulado das rotas de `/oauth`.
 * Regras:
 *  - Exceção deliberada ao problem+json do resto da plataforma: nenhuma biblioteca cliente de
 *    OAuth lê `application/problem+json`; todas leem `{"error": "..."}`. Inventar formato aqui
 *    quebraria todo consumidor pronto. O handler global segue valendo fora de `/oauth`.
 *  - O corpo nunca ecoa o que veio na requisição, nem a mensagem original da exceção: é uma
 *    resposta lida por quem sonda credencial.
 *  - Erro não previsto vira 500 genérico — e o detalhe fica só no log.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ErroDeOAuth, type CodigoDeErroOAuth } from '../errors/oauth-error.js';

export interface RespostaDeErroOAuth {
  readonly status: number;
  readonly corpo: {
    readonly error: CodigoDeErroOAuth | 'slow_down' | 'server_error';
    readonly error_description: string;
  };
  readonly cabecalhos: Readonly<Record<string, string>>;
}

/** Cabeçalho exigido pela RFC 6749 §5.1 em qualquer resposta do endpoint de token. */
export const CABECALHOS_SEM_CACHE: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
};

interface ErroComStatus {
  readonly statusCode?: number;
}

/** Decide status, corpo e cabeçalhos a partir do erro recebido. */
export function montarRespostaDeErro(erro: unknown): RespostaDeErroOAuth {
  if (erro instanceof ErroDeOAuth) {
    return {
      status: erro.status,
      corpo: { error: erro.codigo, error_description: erro.descricao },
      cabecalhos:
        erro.codigo === 'invalid_client'
          ? // A RFC 6749 §5.2 manda o desafio quando o cliente falhou a autenticação.
            { ...CABECALHOS_SEM_CACHE, 'www-authenticate': 'Basic realm="iam"' }
          : CABECALHOS_SEM_CACHE,
    };
  }

  if (hasZodFastifySchemaValidationErrors(erro)) {
    return {
      status: 400,
      corpo: {
        error: 'invalid_request',
        error_description: 'Requisição malformada ou com parâmetro obrigatório ausente.',
      },
      cabecalhos: CABECALHOS_SEM_CACHE,
    };
  }

  const status = (erro as ErroComStatus).statusCode ?? 500;

  if (status === 429) {
    return {
      status,
      corpo: { error: 'slow_down', error_description: 'Limite de requisições excedido.' },
      cabecalhos: CABECALHOS_SEM_CACHE,
    };
  }

  // Corpo grande demais, tipo de mídia recusado pelo Fastify, formulário malformado: tudo o
  // que o cliente pode corrigir mudando a requisição é `invalid_request`.
  if (status >= 400 && status < 500) {
    return {
      status,
      corpo: {
        error: 'invalid_request',
        error_description: 'Requisição malformada ou com parâmetro obrigatório ausente.',
      },
      cabecalhos: CABECALHOS_SEM_CACHE,
    };
  }

  return {
    status: 500,
    corpo: { error: 'server_error', error_description: 'Erro interno.' },
    cabecalhos: CABECALHOS_SEM_CACHE,
  };
}

/** Instala o tratador no escopo recebido — o encapsulado das rotas de OAuth. */
export function registrarTratadorDeErro(escopo: FastifyInstance): void {
  escopo.setErrorHandler((erro: unknown, requisicao: FastifyRequest, resposta: FastifyReply) => {
    const { status, corpo, cabecalhos } = montarRespostaDeErro(erro);

    if (status >= 500) {
      requisicao.log.error({ err: erro }, 'oauth: erro não tratado');
    } else {
      requisicao.log.warn({ erro: corpo.error }, 'oauth: requisição recusada');
    }

    void resposta.status(status).headers(cabecalhos).type('application/json').send(corpo);
  });
}
