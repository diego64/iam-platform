/**
 * Contrato: as rotas de clientes estão documentadas no openapi.yaml com os status que o
 * código devolve, e os schemas de cliente são estritos.
 *
 * O `additionalProperties: false` aqui é a garantia de que nenhum campo de segredo escapa
 * pelas rotas de leitura. Sem esta guarda, afrouxar o schema passaria despercebido — e nesta
 * tabela as colunas novas prováveis são justamente hashes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

function blocoDoPath(path: string): string {
  const inicio = contrato.indexOf(`\n  ${path}:`);
  expect(inicio, `path ${path} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}\/[\w-]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

function blocoDoSchema(nome: string): string {
  const inicio = contrato.indexOf(`\n    ${nome}:`);
  expect(inicio, `schema ${nome} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {4}\w+:\n/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

describe('rotas de clientes no openapi.yaml', () => {
  it('a tag clients está declarada', () => {
    expect(contrato).toContain('name: clients');
  });

  it('/clients documenta a criação com superadmin e o 422 de escopo', () => {
    const bloco = blocoDoPath('/clients');
    for (const status of ["'201'", "'400'", "'401'", "'403'", "'409'", "'422'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('superadmin');
    expect(bloco).toContain('ApiClientCreated');
    expect(bloco).toContain('ApiClientList');
  });

  it('/clients/{id} documenta a autoridade dividida do patch', () => {
    const bloco = blocoDoPath('/clients/{id}');
    expect(bloco).toContain('clients:write');
    expect(bloco).toContain('superadmin');
    // O comportamento do corpo misto é contrato, não detalhe de implementação.
    expect(bloco).toContain('403 sem aplicar nada');
    for (const status of ["'200'", "'204'", "'403'", "'404'", "'409'"]) {
      expect(bloco).toContain(status);
    }
  });

  it('/clients/{id}/secret documenta a janela de sobreposição', () => {
    const bloco = blocoDoPath('/clients/{id}/secret');
    expect(bloco).toContain('overlap_seconds');
    expect(bloco).toContain('maximum: 604800');
    expect(bloco).toContain('RotatedSecret');
  });

  it('/clients/{id}/secret/revoke-previous documenta 204 e 409', () => {
    const bloco = blocoDoPath('/clients/{id}/secret/revoke-previous');
    expect(bloco).toContain("'204'");
    expect(bloco).toContain("'409'");
  });

  it('os schemas de cliente são estritos', () => {
    for (const schema of ['ApiClient', 'ApiClientList', 'RotatedSecret']) {
      expect(blocoDoSchema(schema)).toContain('additionalProperties: false');
    }
  });

  // O segredo aparece na criação e na rotação. Em nenhum outro schema.
  it('só os dois schemas de emissão declaram client_secret', () => {
    expect(blocoDoSchema('ApiClient')).not.toContain('client_secret');
    expect(blocoDoSchema('ApiClientList')).not.toContain('client_secret');
    expect(blocoDoSchema('ApiClientCreated')).toContain('client_secret');
    expect(blocoDoSchema('RotatedSecret')).toContain('client_secret');
  });

  it('nenhum schema de cliente declara hash de segredo', () => {
    for (const schema of ['ApiClient', 'ApiClientCreated', 'ApiClientList', 'RotatedSecret']) {
      const bloco = blocoDoSchema(schema);
      expect(bloco).not.toContain('secret_hash');
      expect(bloco).not.toContain('previous_secret_hash');
    }
  });

  it('o escopo é restrito ao formato recurso:acao, o que já exclui o curinga', () => {
    expect(blocoDoPath('/clients')).toContain("pattern: '^[a-z0-9_-]+:[a-z0-9_-]+$'");
  });
});
