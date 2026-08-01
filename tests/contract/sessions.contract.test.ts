/**
 * Contrato: as rotas de sessão estão documentadas no openapi.yaml com os status que o código
 * devolve e com os schemas de resposta. Sem esta guarda o OpenAPI vira decoração e a
 * divergência só aparece para quem gerou cliente a partir dele.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

/** Bloco YAML de um path, até o próximo path de mesma indentação. */
function blocoDoPath(path: string): string {
  const inicio = contrato.indexOf(`\n  ${path}:`);
  expect(inicio, `path ${path} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}\/[\w{-]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

describe('rotas de sessão no openapi.yaml', () => {
  it('/auth/sessions documenta GET e DELETE com Bearer', () => {
    const bloco = blocoDoPath('/auth/sessions');
    expect(bloco).toContain('listSessions');
    expect(bloco).toContain('revokeOtherSessions');
    expect(bloco).toContain('SessionsResponse');
    expect(bloco).toContain('RevokeOthersResponse');
    expect(bloco).toContain('BearerAuth');
  });

  it('/auth/sessions/{id} documenta 204, 400, 401 e 404', () => {
    const bloco = blocoDoPath('/auth/sessions/{id}');
    for (const status of ["'204'", "'400'", "'401'", "'404'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('revokeSession');
  });
});
