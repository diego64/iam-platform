/**
 * Responsabilidade: limitar por uma identidade que só existe **depois** do corpo — conta ou
 * cliente —, o que o hook do `@fastify/rate-limit` não alcança.
 * Consumido por: as rotas de login, token e verificação de segundo fator.
 * Regras:
 *  - O plugin roda em `onRequest`, antes de o corpo ser lido, e por isso só enxerga o IP.
 *    Um atacante com mil IPs faz mil tentativas contra a mesma conta sem tocar naquele teto.
 *    Este hook é o que fecha isso.
 *  - **Verifica antes, debita depois.** Só tentativa falha consome cota: um limite por conta
 *    que conta acerto pune o usuário legítimo que usa muito o app, exatamente quando ele mais
 *    usa. O débito acontece no `onResponse`, olhando o status.
 *  - Erro do servidor (5xx) **não** debita: o usuário não paga cota por falha nossa.
 *  - Requisição sem identidade extraível (corpo malformado, campo ausente) passa direto: a
 *    validação da rota é quem responde por isso, e inventar uma chave aqui misturaria
 *    tentativas de gente diferente no mesmo balde.
 */
import type {
  FastifyReply,
  FastifyRequest,
  onResponseAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import type { DimensaoDeLimite } from './types.js';
import type { PoliticaDeRateLimit } from './politica.js';

export interface ConfiguracaoDoHook {
  readonly politica: PoliticaDeRateLimit;
  readonly dimensao: DimensaoDeLimite;
  readonly teto: number;
  readonly janelaMs: number;
  /** Extrai a identidade da requisição. `null` quando não há o que limitar. */
  readonly identificar: (requisicao: FastifyRequest) => string | null;
  /** Como responder ao excesso. Cada família de rota tem o seu formato. */
  readonly responder: (resposta: FastifyReply, retryAfterSegundos: number) => Promise<void>;
}

/** Status que contam como tentativa falha. 5xx fica de fora de propósito. */
function ehFalhaDoCliente(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * Devolve o par de hooks: o `preHandler` que barra quem já estourou e o `onResponse` que
 * debita a tentativa falha.
 */
export function criarHookDeLimitePorIdentidade(config: ConfiguracaoDoHook): {
  preHandler: preHandlerAsyncHookHandler;
  onResponse: onResponseAsyncHookHandler;
} {
  const chaveDaRequisicao = Symbol.for('iam.rate-limit.identidade');

  function consultaDe(
    valor: string,
    rota: string,
  ): Parameters<PoliticaDeRateLimit['verificar']>[0] {
    return {
      dimensao: config.dimensao,
      valor,
      teto: config.teto,
      janelaMs: config.janelaMs,
      rota,
    };
  }

  return {
    preHandler: async (requisicao, resposta) => {
      const identidade = config.identificar(requisicao);
      if (identidade === null) return;

      // Guardado na requisição para o `onResponse` não repetir a extração — e para ele não
      // depender de o corpo ainda estar lá.
      (requisicao as unknown as Record<symbol, string>)[chaveDaRequisicao] = identidade;

      const rota = requisicao.routeOptions.url ?? requisicao.url;
      const veredito = await config.politica.verificar(consultaDe(identidade, rota));
      if (!veredito.permitido) {
        await config.responder(resposta, veredito.retryAfterSegundos);
      }
    },

    onResponse: async (requisicao, resposta) => {
      const identidade = (requisicao as unknown as Record<symbol, string | undefined>)[
        chaveDaRequisicao
      ];
      if (identidade === undefined) return;
      if (!ehFalhaDoCliente(resposta.statusCode)) return;

      const rota = requisicao.routeOptions.url ?? requisicao.url;
      await config.politica.debitar(consultaDe(identidade, rota));
    },
  };
}
