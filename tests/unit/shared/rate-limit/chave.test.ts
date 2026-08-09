/**
 * Cobre a derivação da chave: determinismo, ausência de colisão entre dimensões, normalização
 * e a garantia de que o identificador em claro não sobrevive na saída.
 */
import { describe, expect, it } from 'vitest';
import { derivarChave } from '../../../../src/shared/rate-limit/chave.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const EMAIL = 'admin@iam.local';

describe('derivarChave', () => {
  it('é determinística para o mesmo par dimensão + valor', () => {
    expect(derivarChave('conta', EMAIL, PEPPER)).toBe(derivarChave('conta', EMAIL, PEPPER));
  });

  it('dimensões diferentes com o mesmo valor não colidem', () => {
    // Sem isso, a cota de IP e a de conta se misturariam quando o valor coincidisse.
    const conta = derivarChave('conta', '10.0.0.1', PEPPER);
    const ip = derivarChave('ip', '10.0.0.1', PEPPER);

    expect(conta).not.toBe(ip);
    expect(conta.split(':')[1]).not.toBe(ip.split(':')[1]);
  });

  it('valores diferentes na mesma dimensão não colidem', () => {
    expect(derivarChave('conta', EMAIL, PEPPER)).not.toBe(
      derivarChave('conta', 'outro@iam.local', PEPPER),
    );
  });

  it('normaliza caixa e espaço — é a mesma conta', () => {
    expect(derivarChave('conta', '  ADMIN@iam.local ', PEPPER)).toBe(
      derivarChave('conta', EMAIL, PEPPER),
    );
  });

  it('o identificador em claro não aparece na saída', () => {
    const chave = derivarChave('conta', EMAIL, PEPPER);

    expect(chave).not.toContain(EMAIL);
    expect(chave).not.toContain('admin');
    expect(chave).not.toContain('iam.local');
  });

  it('o pepper muda o resultado', () => {
    expect(derivarChave('conta', EMAIL, PEPPER)).not.toBe(
      derivarChave('conta', EMAIL, 'outro-pepper-com-mais-de-32-bytes-aqui'),
    );
  });

  it('mantém a dimensão legível como prefixo, e só ela', () => {
    const chave = derivarChave('cliente', 'cli_abc', PEPPER);

    expect(chave).toMatch(/^cliente:[0-9a-f]{64}$/);
  });
});
