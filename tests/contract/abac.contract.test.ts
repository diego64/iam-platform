/**
 * Contrato: as rotas do ABAC estão documentadas no openapi.yaml com os status que o código
 * devolve e com o schema da condição. Sem esta guarda o OpenAPI diverge do guard e do
 * controller sem ninguém notar — e é o OpenAPI que o consumidor externo lê para saber que
 * o PDP online existe.
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

describe('rotas do ABAC no openapi.yaml', () => {
  it('a tag abac está declarada e diz que a decisão não entra no token', () => {
    expect(contrato).toContain('name: abac');
    expect(contrato).toContain('nunca');
  });

  it('/policies documenta criação (201/400/409) e listagem, exigindo Bearer', () => {
    const bloco = blocoDoPath('/policies');
    for (const status of ["'201'", "'200'", "'400'", "'401'", "'403'", "'409'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('PolicyList');
    expect(bloco).toContain('policies:write');
    expect(bloco).toContain('policies:read');
  });

  it('/policies/{id} documenta detalhe, patch e delete com 404 e 409 de imutabilidade', () => {
    const bloco = blocoDoPath('/policies/{id}');
    for (const status of ["'200'", "'204'", "'403'", "'404'", "'409'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('PolicyDetail');
    expect(bloco).toContain('is_system');
    expect(bloco).toContain('policies:delete');
  });

  it('/policies/evaluate documenta a decisão e exige policies:read', () => {
    const bloco = blocoDoPath('/policies/evaluate');
    expect(bloco).toContain('PolicyDecision');
    expect(bloco).toContain('policies:read');
    expect(bloco).toContain('resource_type');
    expect(bloco).toContain("'403'");
  });

  it('o schema da condição declara a gramática fechada e os limites de forma', () => {
    expect(contrato).toContain('PolicyCondition:');
    for (const op of ['and', 'or', 'not', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']) {
      expect(contrato).toMatch(new RegExp(`enum: \\[[^\\]]*\\b${op}\\b`));
    }
    // O teto de forma é contrato: o consumidor precisa saber por que levou 400.
    expect(contrato).toContain('profundidade <= 10');
    expect(contrato).toContain('100 nós');
  });

  it('a decisão expõe policy_id opcional e os dois motivos possíveis', () => {
    expect(contrato).toContain('no-applicable-policy');
    expect(contrato).toContain('matched');
    expect(contrato).toContain('policy_id');
  });
});
