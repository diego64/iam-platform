/**
 * Cobre a higienização de atributos antes de o span sair do processo.
 *
 * O que se prova aqui não é que a limpeza "funciona" em abstrato, e sim que os atributos
 * pelos quais um segredo passa de verdade estão na lista: a instrumentação de HTTP publica
 * a URL completa, e por ela transitam o código de autorização e o token de troca de senha.
 * Um trace fica retido e indexado por meses — muito além da validade do segredo.
 */
import { describe, expect, it } from 'vitest';
import { tracing } from '@opentelemetry/sdk-node';
import { limparAtributosSensiveis } from '../../../src/telemetry/sdk.js';

/** Span mínimo: o processador só lê e escreve `attributes`. */
function spanCom(atributos: Record<string, unknown>): tracing.ReadableSpan {
  return { attributes: atributos } as unknown as tracing.ReadableSpan;
}

const TOKEN = 'token-de-reset-que-nao-pode-vazar';

describe('atributos de URL', () => {
  it('remove a URL completa, que carrega a query string', () => {
    const atributos = {
      'url.full': `https://iam.exemplo.com/auth/password/reset?token=${TOKEN}`,
    };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(atributos).not.toHaveProperty('url.full');
  });

  it('remove todas as formas em que a URL é publicada', () => {
    const atributos: Record<string, unknown> = {
      'url.full': `/x?token=${TOKEN}`,
      'url.query': `token=${TOKEN}`,
      'url.path': '/auth/password/reset',
      'http.target': `/x?token=${TOKEN}`,
      'http.url': `/x?token=${TOKEN}`,
    };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(Object.keys(atributos)).toEqual([]);
  });

  it('nenhum valor do span exportado contém o segredo', () => {
    const atributos = {
      'http.route': '/auth/password/reset',
      'url.full': `/auth/password/reset?token=${TOKEN}`,
      'url.query': `token=${TOKEN}`,
    };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(JSON.stringify(atributos)).not.toContain(TOKEN);
  });
});

describe('o que precisa sobreviver', () => {
  it('preserva o template da rota, que é o que serve para agrupar', () => {
    const atributos = { 'http.route': '/users/:id', 'url.full': '/users/42' };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(atributos).toEqual({ 'http.route': '/users/:id' });
  });

  it('não mexe em atributo que não está na lista', () => {
    const atributos = { 'http.request.method': 'POST', 'http.response.status_code': 200 };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(atributos).toEqual({ 'http.request.method': 'POST', 'http.response.status_code': 200 });
  });
});

describe('topologia interna', () => {
  it('continua removendo a string de conexão e o usuário do banco', () => {
    const atributos = {
      'db.connection_string': 'postgres://iam@10.0.0.7:5432/iam',
      'db.user': 'iam',
    };

    limparAtributosSensiveis().onEnd(spanCom(atributos));

    expect(Object.keys(atributos)).toEqual([]);
  });
});
