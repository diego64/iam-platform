/**
 * Contrato: as rotas de /users estão documentadas no openapi.yaml com os status que o
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
  const proximo = resto.slice(1).search(/\n {2}\/[\w-{]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

describe('rotas de usuário no openapi.yaml', () => {
  it('/users documenta 201, 400, 401, 403, 409 e exige BearerAuth', () => {
    const bloco = blocoDoPath('/users');
    for (const status of ["'201'", "'400'", "'401'", "'403'", "'409'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
  });

  it('/users/{id} documenta 200, 404 e 409 no patch', () => {
    const bloco = blocoDoPath('/users/{id}');
    expect(bloco).toContain("'200'");
    expect(bloco).toContain("'404'");
    expect(bloco).toContain("'409'");
  });

  it('/users/{id}/block documenta 200 e 404', () => {
    const bloco = blocoDoPath('/users/{id}/block');
    expect(bloco).toContain("'200'");
    expect(bloco).toContain("'404'");
  });

  it('o schema Usuario não expõe password_hash', () => {
    expect(contrato).toContain('Usuario:');
    const inicio = contrato.indexOf('Usuario:');
    const trecho = contrato.slice(inicio, inicio + 400);
    expect(trecho).not.toContain('password');
  });

  it('a tag users está declarada', () => {
    expect(contrato).toContain('name: users');
  });
});
