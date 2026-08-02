/**
 * Não-regressão de RF-10: o ABAC não entra no Access Token.
 *
 * A tentação de embarcar a decisão por atributo no token é permanente — resolveria a
 * latência e serviria o consumidor offline. Mas uma condição sobre `resource.owner_id`
 * precisa do recurso em mãos, que a emissão não tem. Este teste trava o contrato de claims
 * no que as SPECs 001 e 003 definiram: quem acrescentar uma claim de política ao token
 * quebra aqui e tem de justificar a mudança de decisão, não passar por descuido.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const tokenService = readFileSync(
  new URL('../../src/modules/auth/services/token.service.ts', import.meta.url),
  'utf8',
);
const verificador = readFileSync(
  new URL('../../src/modules/auth/middleware/verify-access-token.ts', import.meta.url),
  'utf8',
);

/** Claims do payload passadas ao `SignJWT`, na ordem em que aparecem. */
function claimsDoPayload(): string[] {
  const bloco = /new SignJWT\(\{([\s\S]*?)\}\)/.exec(tokenService);
  expect(bloco, 'não achei a construção do SignJWT').not.toBeNull();
  return [...(bloco?.[1] ?? '').matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? '');
}

describe('contrato de claims do Access Token', () => {
  it('o payload carrega exatamente scope, roles e perm', () => {
    expect(claimsDoPayload().sort()).toEqual(['perm', 'roles', 'scope']);
  });

  it('as claims registradas continuam sendo emitidas', () => {
    for (const metodo of [
      'setSubject',
      'setJti',
      'setIssuedAt',
      'setExpirationTime',
      'setIssuer',
      'setAudience',
    ]) {
      expect(tokenService).toContain(metodo);
    }
  });

  it('nenhuma claim de política é emitida', () => {
    for (const proibida of ['policy', 'policies', 'abac', 'condition', 'effect']) {
      expect(claimsDoPayload()).not.toContain(proibida);
    }
  });

  it('o módulo de auth não importa o de ABAC', () => {
    expect(tokenService).not.toContain('abac');
    expect(verificador).not.toContain('abac');
  });

  it('o verificador continua decorando o request com id, roles, permissions e scope', () => {
    for (const campo of ['id:', 'roles:', 'permissions:', 'scope:']) {
      expect(verificador).toContain(campo);
    }
  });
});
