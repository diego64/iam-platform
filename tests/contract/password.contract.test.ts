/**
 * Contrato: as 4 rotas de senha estão documentadas no openapi.yaml com os status que o
 * código realmente devolve. Sem esta guarda o OpenAPI vira decoração e a divergência só
 * aparece para quem gerou cliente a partir dele.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

/** Bloco YAML de um path, até o próximo path de mesma indentação. */
function blocoDoPath(path: string): string {
  const inicio = contrato.indexOf(`\n  ${path}:`);
  expect(inicio, `path ${path} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}\/[\w-]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

describe('rotas de senha no openapi.yaml', () => {
  it('/auth/password/change documenta 204, 400, 401 e 429', () => {
    const bloco = blocoDoPath('/auth/password/change');
    for (const status of ["'204'", "'400'", "'401'", "'429'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
  });

  it('/auth/password/forgot documenta 202 e é declarado sem autenticação', () => {
    const bloco = blocoDoPath('/auth/password/forgot');
    expect(bloco).toContain("'202'");
    expect(bloco).toContain('security: []');
  });

  it('/auth/password/reset documenta 204 e 400 em problem+json', () => {
    const bloco = blocoDoPath('/auth/password/reset');
    expect(bloco).toContain("'204'");
    expect(bloco).toContain("'400'");
    expect(bloco).toContain('application/problem+json');
  });

  it('/auth/password/policy documenta 200 sem autenticação', () => {
    const bloco = blocoDoPath('/auth/password/policy');
    expect(bloco).toContain("'200'");
    expect(bloco).toContain('security: []');
  });

  it('a tag password está declarada', () => {
    expect(contrato).toContain('name: password');
  });
});
