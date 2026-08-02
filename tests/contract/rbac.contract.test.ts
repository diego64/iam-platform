/**
 * Contrato: as rotas do RBAC estão documentadas no openapi.yaml com os status que o código
 * devolve (incl. 403 do guard e 409 de imutabilidade) e com os schemas de request/response.
 * Sem esta guarda o OpenAPI diverge do guard e do controller sem ninguém notar.
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

describe('rotas do RBAC no openapi.yaml', () => {
  it('a tag rbac está declarada', () => {
    expect(contrato).toContain('name: rbac');
  });

  it('/roles documenta criação (201/403) e listagem, exigindo Bearer', () => {
    const bloco = blocoDoPath('/roles');
    for (const status of ["'201'", "'200'", "'401'", "'403'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('RoleList');
  });

  it('/roles/{id} documenta detalhe, patch e delete com 403/404/409', () => {
    const bloco = blocoDoPath('/roles/{id}');
    for (const status of ["'200'", "'403'", "'404'", "'409'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('RoleDetail');
  });

  it('/roles/{id}/permissions documenta superadmin e o 409 do curinga', () => {
    const bloco = blocoDoPath('/roles/{id}/permissions');
    expect(bloco).toContain('superadmin');
    expect(bloco).toContain("'409'");
    expect(bloco).toContain('permission_ids');
  });

  it('/permissions/{id} documenta 409 (permissão de sistema imutável)', () => {
    const bloco = blocoDoPath('/permissions/{id}');
    expect(bloco).toContain("'409'");
    expect(bloco).toContain('ProblemConflito');
  });

  it('escrita de vínculo usuário↔papel documenta 403 (só superadmin)', () => {
    const bloco = blocoDoPath('/users/{id}/roles');
    expect(bloco).toContain("'403'");
    expect(bloco).toContain('role_ids');
    expect(bloco).toContain('UserRoles');
  });

  it('as respostas reutilizáveis de erro do RBAC existem', () => {
    for (const resp of ['ProblemSemPermissao', 'ProblemNaoEncontrado', 'ProblemConflito']) {
      expect(contrato).toContain(`${resp}:`);
    }
  });
});
