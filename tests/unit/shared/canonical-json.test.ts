/**
 * Cobre a canonicalização que sustenta o encadeamento por hash da auditoria.
 *
 * O caso que importa não é "serializa um objeto": é que duas construções diferentes do
 * mesmo conteúdo produzam bytes idênticos. Se a ordem de inserção vazar para a string, a
 * verificação de integridade acusaria adulteração em trilha intacta.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizar, type ValorCanonico } from '../../../src/shared/utils/canonical-json.js';

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

describe('canonicalizar', () => {
  it('produz a mesma string para objetos com as chaves em ordens diferentes', () => {
    const a = { tipo: 'login', ator: { id: 'u1', ip: '203.0.113.10' }, sucesso: true };
    const b = { sucesso: true, ator: { ip: '203.0.113.10', id: 'u1' }, tipo: 'login' };

    expect(canonicalizar(a)).toBe(canonicalizar(b));
    expect(sha256(canonicalizar(a))).toBe(sha256(canonicalizar(b)));
  });

  it('ordena as chaves recursivamente', () => {
    expect(canonicalizar({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('omite chave com valor undefined e preserva null', () => {
    expect(canonicalizar({ a: 1, b: undefined, c: null })).toBe('{"a":1,"c":null}');
  });

  it('preserva a posição dos elementos de um array, trocando undefined por null', () => {
    const valor: ValorCanonico = [1, undefined, 3];
    expect(canonicalizar(valor)).toBe('[1,null,3]');
  });

  it('não deixa a ordem do array influenciar por ordenação — array tem ordem própria', () => {
    expect(canonicalizar(['b', 'a'])).not.toBe(canonicalizar(['a', 'b']));
  });

  it('escreve Date em ISO-8601 UTC', () => {
    const data = new Date('2026-08-03T12:00:00.000Z');
    expect(canonicalizar({ quando: data })).toBe('{"quando":"2026-08-03T12:00:00.000Z"}');
  });

  it('escreve inteiro grande por extenso, sem notação exponencial', () => {
    expect(canonicalizar({ n: 1e21 })).toBe('{"n":1000000000000000000000}');
    expect(canonicalizar({ n: 1042 })).toBe('{"n":1042}');
  });

  it('preserva fracionário sem alterar a representação', () => {
    expect(canonicalizar({ n: 0.5 })).toBe('{"n":0.5}');
  });

  it('recusa número não finito em vez de virar null silenciosamente', () => {
    expect(() => canonicalizar({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalizar({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('escapa aspas e caracteres especiais na chave e no valor', () => {
    expect(canonicalizar({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });
});
