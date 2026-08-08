/**
 * Cobre os códigos de recuperação: entropia e formato, alfabeto sem caractere ambíguo, e a
 * normalização que faz o código digitado à mão casar com o hash guardado.
 */
import { describe, expect, it } from 'vitest';
import {
  FORMATO_CANONICO,
  QUANTIDADE_PADRAO,
  digerirCodigo,
  gerarCodigosDeRecuperacao,
  normalizarCodigo,
} from '../../../../src/modules/mfa/services/recovery-codes.js';

describe('gerarCodigosDeRecuperacao', () => {
  it('gera dez códigos distintos por default', () => {
    const { codigos } = gerarCodigosDeRecuperacao();

    expect(codigos).toHaveLength(QUANTIDADE_PADRAO);
    expect(new Set(codigos).size).toBe(QUANTIDADE_PADRAO);
  });

  it('cada código tem 24 caracteres em quatro grupos de seis', () => {
    const { codigos } = gerarCodigosDeRecuperacao(5);

    for (const codigo of codigos) {
      expect(codigo).toMatch(/^[A-Z2-9]{6}-[A-Z2-9]{6}-[A-Z2-9]{6}-[A-Z2-9]{6}$/);
      expect(normalizarCodigo(codigo)).toMatch(FORMATO_CANONICO);
    }
  });

  it('não usa caractere que se confunde na escrita à mão', () => {
    // Quem digita o código está no pior dia dele; O/0 e I/1 são o erro clássico.
    const { codigos } = gerarCodigosDeRecuperacao(30);

    expect(codigos.join('')).not.toMatch(/[OI01]/);
  });

  it('o hash entregue corresponde ao código entregue', () => {
    const { codigos, hashes } = gerarCodigosDeRecuperacao(3);

    expect(hashes).toEqual(codigos.map((codigo) => digerirCodigo(codigo)));
  });

  it('gerações sucessivas não repetem', () => {
    const primeira = gerarCodigosDeRecuperacao(10).codigos;
    const segunda = gerarCodigosDeRecuperacao(10).codigos;

    expect(primeira.some((codigo) => segunda.includes(codigo))).toBe(false);
  });
});

describe('normalizarCodigo', () => {
  it('ignora caixa, hífen e espaço', () => {
    const { codigos } = gerarCodigosDeRecuperacao(1);
    const original = codigos[0] as string;
    const canonico = digerirCodigo(original);

    for (const variante of [
      original.toLowerCase(),
      original.replace(/-/g, ''),
      original.replace(/-/g, ' '),
      `  ${original}  `,
    ]) {
      expect(digerirCodigo(variante)).toBe(canonico);
    }
  });

  it('código diferente dá hash diferente', () => {
    expect(digerirCodigo('ABCDEF-GHJKLM-NPQRST-UVWXYZ')).not.toBe(
      digerirCodigo('ABCDEF-GHJKLM-NPQRST-UVWXY2'),
    );
  });
});
