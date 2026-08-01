/**
 * Contrato: as 3 rotas de autenticação estão documentadas no openapi.yaml com os status que
 * o código realmente devolve e com os schemas de request/response. Sem esta guarda o OpenAPI
 * vira decoração e a divergência só aparece para quem gerou cliente a partir dele.
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

describe('rotas de autenticação no openapi.yaml', () => {
  it('/auth/login documenta 200, 400, 401 e 429, sem autenticação', () => {
    const bloco = blocoDoPath('/auth/login');
    for (const status of ["'200'", "'400'", "'401'", "'429'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('security: []');
    expect(bloco).toContain('LoginRequest');
    expect(bloco).toContain('LoginResponse');
  });

  it('/auth/logout documenta 204 e 401 e exige Bearer', () => {
    const bloco = blocoDoPath('/auth/logout');
    expect(bloco).toContain("'204'");
    expect(bloco).toContain("'401'");
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('LogoutRequest');
  });

  it('/auth/me documenta 200 e 401 e exige Bearer', () => {
    const bloco = blocoDoPath('/auth/me');
    expect(bloco).toContain("'200'");
    expect(bloco).toContain("'401'");
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('MeResponse');
  });

  it('o LoginResponse tem os campos do contrato de token', () => {
    for (const campo of ['access_token', 'refresh_token', 'token_type', 'expires_in']) {
      expect(contrato).toContain(`${campo}:`);
    }
  });

  it('a tag auth está declarada', () => {
    expect(contrato).toContain('name: auth');
  });
});
