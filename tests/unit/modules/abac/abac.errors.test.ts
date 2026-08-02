/**
 * A tradução de erro de domínio → problem+json é contrato do módulo: um código sem
 * tradução viraria 500 na borda, e um status trocado (403 no lugar de 409) mentiria sobre
 * a natureza da recusa. Este teste fixa os dois.
 */
import { describe, expect, it } from 'vitest';
import {
  ErroDeAbac,
  TRADUCAO_DE_ERRO_DE_ABAC,
  type CodigoDeErroDeAbac,
} from '../../../../src/modules/abac/errors/abac.errors.js';

const CODIGOS: CodigoDeErroDeAbac[] = [
  'politica-nao-encontrada',
  'politica-conflito',
  'politica-imutavel',
  'condicao-invalida',
];

describe('ErroDeAbac', () => {
  it('carrega o código e é reconhecível por instanceof', () => {
    const erro = new ErroDeAbac('politica-imutavel');
    expect(erro).toBeInstanceOf(ErroDeAbac);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.codigo).toBe('politica-imutavel');
    expect(erro.name).toBe('ErroDeAbac');
  });

  it('traduz cada código para o status e o slug esperados', () => {
    expect(TRADUCAO_DE_ERRO_DE_ABAC['politica-nao-encontrada']).toMatchObject({
      status: 404,
      slug: 'policy-not-found',
    });
    expect(TRADUCAO_DE_ERRO_DE_ABAC['politica-conflito']).toMatchObject({
      status: 409,
      slug: 'policy-already-exists',
    });
    expect(TRADUCAO_DE_ERRO_DE_ABAC['politica-imutavel']).toMatchObject({
      status: 409,
      slug: 'system-policy-immutable',
    });
    expect(TRADUCAO_DE_ERRO_DE_ABAC['condicao-invalida']).toMatchObject({
      status: 400,
      slug: 'invalid-condition',
    });
  });

  it('cobre todos os códigos, sem slug repetido', () => {
    expect(Object.keys(TRADUCAO_DE_ERRO_DE_ABAC).sort()).toEqual([...CODIGOS].sort());
    const slugs = CODIGOS.map((c) => TRADUCAO_DE_ERRO_DE_ABAC[c].slug);
    expect(new Set(slugs).size).toBe(CODIGOS.length);
  });
});
