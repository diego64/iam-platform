/**
 * Contrato: a rota de rotação está documentada no openapi.yaml com os status que o código
 * realmente devolve e com os schemas de request/response. Sem esta guarda o OpenAPI vira
 * decoração e a divergência só aparece para quem gerou cliente a partir dele.
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

describe('rota de refresh no openapi.yaml', () => {
  it('/auth/refresh documenta 200, 400, 401 e 429, sem autenticação', () => {
    const bloco = blocoDoPath('/auth/refresh');
    for (const status of ["'200'", "'400'", "'401'", "'429'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('security: []');
    expect(bloco).toContain('RefreshRequest');
    expect(bloco).toContain('RefreshResponse');
  });

  it('RefreshRequest exige refresh_token de 88 caracteres', () => {
    expect(contrato).toContain('RefreshRequest:');
    const inicio = contrato.indexOf('RefreshRequest:');
    const bloco = contrato.slice(inicio, inicio + 300);
    expect(bloco).toContain('minLength: 88');
    expect(bloco).toContain('maxLength: 88');
  });
});
