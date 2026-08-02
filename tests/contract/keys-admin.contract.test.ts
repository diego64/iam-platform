/**
 * Contrato: as rotas administrativas de chaves estão documentadas no openapi.yaml com os
 * status que o código devolve e com os schemas de resposta estritos.
 *
 * O `additionalProperties: false` nos schemas de chave não é estilo: é a garantia de que
 * nenhum campo de material privado escapa por estas rotas. Sem esta guarda, afrouxar o
 * schema passaria despercebido.
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

/** Bloco YAML de um schema em components/schemas. */
function blocoDoSchema(nome: string): string {
  const inicio = contrato.indexOf(`\n    ${nome}:`);
  expect(inicio, `schema ${nome} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {4}\w+:\n/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

describe('rotas administrativas de chaves no openapi.yaml', () => {
  it('a tag keys está declarada', () => {
    expect(contrato).toContain('name: keys');
  });

  it('/admin/keys documenta listagem com filtro e os erros de autorização', () => {
    const bloco = blocoDoPath('/admin/keys');
    for (const status of ["'200'", "'400'", "'401'", "'403'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('KeyList');
    expect(bloco).toContain('keys:read');
  });

  it('/admin/keys/prepare documenta 201 e 200 — repetir é idempotente', () => {
    const bloco = blocoDoPath('/admin/keys/prepare');
    expect(bloco).toContain("'201'");
    expect(bloco).toContain("'200'");
    expect(bloco).toContain('PreparedKey');
    expect(bloco).toContain('keys:write');
  });

  it('/admin/keys/rotate documenta o 409 das recusas de promoção', () => {
    const bloco = blocoDoPath('/admin/keys/rotate');
    expect(bloco).toContain("'409'");
    expect(bloco).toContain('ProblemConflito');
    expect(bloco).toContain('RotationResult');
  });

  it('/admin/keys/{kid}/revoke documenta o papel superadmin e o 404', () => {
    const bloco = blocoDoPath('/admin/keys/{kid}/revoke');
    expect(bloco).toContain('superadmin');
    for (const status of ["'200'", "'400'", "'403'", "'404'", "'409'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('RevocationResult');
    // Motivo obrigatório: a revogação precisa deixar rastro do porquê.
    expect(bloco).toContain('required: [motivo]');
  });

  it('os schemas de chave são estritos — nenhum campo extra passa', () => {
    for (const schema of ['KeyMetadata', 'KeyList', 'PreparedKey', 'RotationResult']) {
      expect(blocoDoSchema(schema)).toContain('additionalProperties: false');
    }
  });

  it('nenhum schema de chave declara campo de material privado', () => {
    for (const schema of ['KeyMetadata', 'PreparedKey', 'RotationResult', 'RevocationResult']) {
      const bloco = blocoDoSchema(schema);
      expect(bloco).not.toContain('private_key_enc');
      expect(bloco).not.toContain('public_jwk');
      expect(bloco).not.toMatch(/^\s+d:/m);
    }
  });

  it('o contrato público do JWKS segue sem material privado depois da rotação', () => {
    expect(blocoDoSchema('Jwk')).toContain('additionalProperties: false');
    expect(blocoDoSchema('Jwk')).not.toMatch(/^\s+d:/m);
  });
});
