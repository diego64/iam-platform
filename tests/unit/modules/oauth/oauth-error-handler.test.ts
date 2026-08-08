/**
 * Cobre a tradução de erro para o formato da RFC 6749: código e status por tipo de erro,
 * desafio `WWW-Authenticate` no `invalid_client`, ausência de cache em toda resposta e
 * silêncio sobre o detalhe interno em erro não previsto.
 */
import { describe, expect, it } from 'vitest';
import {
  CABECALHOS_SEM_CACHE,
  montarRespostaDeErro,
} from '../../../../src/modules/oauth/routes/oauth-error-handler.js';
import { ErroDeOAuth } from '../../../../src/modules/oauth/errors/oauth-error.js';
import { analisarFormulario } from '../../../../src/modules/oauth/routes/form-body.js';

describe('montarRespostaDeErro', () => {
  it('traduz o erro de domínio para o código da RFC', () => {
    const resposta = montarRespostaDeErro(new ErroDeOAuth('invalid_grant'));

    expect(resposta.status).toBe(400);
    expect(resposta.corpo.error).toBe('invalid_grant');
    expect(resposta.cabecalhos).toMatchObject(CABECALHOS_SEM_CACHE);
  });

  it('invalid_client responde 401 com o desafio Basic', () => {
    const resposta = montarRespostaDeErro(new ErroDeOAuth('invalid_client'));

    expect(resposta.status).toBe(401);
    expect(resposta.cabecalhos['www-authenticate']).toBe('Basic realm="iam"');
  });

  it('limite de requisições vira slow_down', () => {
    const resposta = montarRespostaDeErro({ statusCode: 429 });

    expect(resposta.status).toBe(429);
    expect(resposta.corpo.error).toBe('slow_down');
  });

  it('corpo grande demais vira invalid_request', () => {
    const resposta = montarRespostaDeErro({ statusCode: 413 });

    expect(resposta.status).toBe(413);
    expect(resposta.corpo.error).toBe('invalid_request');
  });

  it('erro não previsto vira server_error sem vazar detalhe', () => {
    const resposta = montarRespostaDeErro(new Error('conexão recusada em 10.0.0.5:5432'));

    expect(resposta.status).toBe(500);
    expect(resposta.corpo.error).toBe('server_error');
    expect(JSON.stringify(resposta.corpo)).not.toContain('10.0.0.5');
  });

  it('toda resposta de erro sai sem cache', () => {
    for (const erro of [new ErroDeOAuth('invalid_scope'), { statusCode: 429 }, new Error('x')]) {
      const resposta = montarRespostaDeErro(erro);
      expect(resposta.cabecalhos['cache-control']).toBe('no-store');
      expect(resposta.cabecalhos.pragma).toBe('no-cache');
    }
  });
});

describe('analisarFormulario', () => {
  it('converte os pares em texto', () => {
    expect(analisarFormulario('grant_type=client_credentials&scope=orders%3Aread')).toEqual({
      grant_type: 'client_credentials',
      scope: 'orders:read',
    });
  });

  it('recusa parâmetro repetido', () => {
    // Aceitar a última ocorrência deixaria esconder um escopo depois do que a vítima assinou.
    expect(() => analisarFormulario('scope=orders:read&scope=users:delete')).toThrow(ErroDeOAuth);
  });

  it('corpo vazio vira objeto vazio', () => {
    expect(analisarFormulario('')).toEqual({});
  });

  it('não herda propriedades de Object', () => {
    const campos = analisarFormulario('grant_type=password');

    expect(Object.getPrototypeOf(campos)).toBeNull();
    expect(campos.constructor).toBeUndefined();
  });
});
