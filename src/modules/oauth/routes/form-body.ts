/**
 * Responsabilidade: aceitar o corpo `application/x-www-form-urlencoded` que a RFC 6749 §4
 * exige, no escopo das rotas de OAuth e só nele.
 * Regras:
 *  - `querystring` da stdlib resolve o parsing; um plugin dedicado seria uma dependência a
 *    manter e auditar para o que cabe em cinco linhas.
 *  - O parser é registrado no escopo encapsulado, nunca globalmente: habilitar formulário em
 *    toda a aplicação abriria superfície de CSRF em endpoints que hoje só falam JSON.
 *  - Parâmetro repetido é recusado. A RFC 6749 §3.1 proíbe repetição, e aceitar a última
 *    ocorrência deixaria um atacante esconder um `scope` depois do que a vítima assinou.
 */
import { parse } from 'node:querystring';
import type { FastifyInstance } from 'fastify';
import { ErroDeOAuth } from '../errors/oauth-error.js';

/** Teto do corpo. O endpoint recebe alguns campos curtos; o resto é abuso. */
export const LIMITE_DO_CORPO_BYTES = 8 * 1024;

/**
 * Converte o corpo em pares de texto.
 * @throws {ErroDeOAuth} `invalid_request` quando algum parâmetro aparece mais de uma vez.
 */
export function analisarFormulario(corpo: string): Record<string, string> {
  const cru = parse(corpo);
  const campos: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const [chave, valor] of Object.entries(cru)) {
    if (Array.isArray(valor)) {
      throw new ErroDeOAuth('invalid_request', 'Parâmetro repetido na requisição.');
    }
    if (valor !== undefined) {
      campos[chave] = valor;
    }
  }

  return campos;
}

/** Registra o parser no escopo recebido — que deve ser o encapsulado das rotas de OAuth. */
export function registrarParserDeFormulario(escopo: FastifyInstance): void {
  escopo.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: LIMITE_DO_CORPO_BYTES },
    (_requisicao, corpo, feito) => {
      try {
        feito(null, analisarFormulario(corpo as string));
      } catch (erro) {
        feito(erro as Error, undefined);
      }
    },
  );
}
