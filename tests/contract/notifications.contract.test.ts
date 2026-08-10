/**
 * Contrato: a rota de teste de entrega está documentada com os status que o código devolve,
 * e o schema de resposta é fechado.
 *
 * O `additionalProperties: false` não é preciosismo de documentação: é a guarda de que um
 * campo novo com endereço ou com a mensagem do provedor quebra o contrato em vez de vazar
 * silenciosamente para quem consome a rota.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAUSAS_DE_FALHA } from '../../src/modules/notifications/constants/tipos.js';

const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

function blocoDoPath(path: string): string {
  const inicio = contrato.indexOf(`\n  ${path}:`);
  expect(inicio, `path ${path} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.slice(1).search(/\n {2}\/[\w-]/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

function blocoDoSchema(nome: string): string {
  const inicio = contrato.indexOf(`    ${nome}:`);
  expect(inicio, `schema ${nome} ausente no openapi`).toBeGreaterThan(-1);
  const resto = contrato.slice(inicio + 1);
  const proximo = resto.search(/\n {4}[A-Z][\w]*:/);
  return proximo === -1 ? resto : resto.slice(0, proximo);
}

describe('/notifications/test no openapi.yaml', () => {
  it('documenta 200, 403, 409 e 429, com autenticação', () => {
    const bloco = blocoDoPath('/notifications/test');

    for (const status of ["'200'", "'403'", "'409'", "'429'"]) {
      expect(bloco).toContain(status);
    }
    expect(bloco).toContain('BearerAuth');
    expect(bloco).toContain('ResultadoDeTesteDeNotificacao');
  });

  it('o corpo aceito é vazio e fechado', () => {
    const bloco = blocoDoPath('/notifications/test');

    // Um campo de endereço aqui transformaria a rota num relay de spam autenticado.
    expect(bloco).toContain('additionalProperties: false');
    expect(bloco).not.toContain('email');
    expect(bloco).not.toContain('para:');
  });

  it('não existe rota de envio arbitrário nem de histórico', () => {
    expect(contrato).not.toContain('\n  /notifications:');
    expect(contrato).not.toContain('/notifications/preferences');
  });
});

describe('ResultadoDeTesteDeNotificacao', () => {
  it('é fechado — campo novo quebra o contrato em vez de vazar', () => {
    expect(blocoDoSchema('ResultadoDeTesteDeNotificacao')).toContain('additionalProperties: false');
  });

  it('a causa documentada é o mesmo vocabulário fechado do código', () => {
    const bloco = blocoDoSchema('ResultadoDeTesteDeNotificacao');

    // Divergir aqui devolveria ao cliente uma causa que ele não sabe interpretar.
    expect(bloco).toContain(`enum: [${CAUSAS_DE_FALHA.join(', ')}]`);
  });

  it('não devolve os endereços, só quantos foram', () => {
    const bloco = blocoDoSchema('ResultadoDeTesteDeNotificacao');

    expect(bloco).toContain('destinatarios:');
    expect(bloco).toContain('type: integer');
  });
});
