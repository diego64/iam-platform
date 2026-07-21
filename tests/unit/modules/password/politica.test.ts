/**
 * Cobre a política de senha por regra, e a concordância entre o validador de domínio e o
 * refinement Zod da borda — os dois têm de reprovar exatamente os mesmos casos.
 */
import { describe, expect, it } from 'vitest';
import {
  avaliarPolitica,
  POLITICA,
  type MotivoRejeicao,
} from '../../../../src/modules/password/validators/politica.js';
import { senhaForte } from '../../../../src/modules/password/schemas/senha-forte.js';

/** Casos de senha reprovada, com o motivo esperado (sem contexto de e-mail). */
const REPROVADAS: readonly (readonly [string, string, MotivoRejeicao])[] = [
  ['curta', 'Ab1!xyz', 'comprimento'],
  ['só duas classes', 'abcdefghijkl', 'classes'],
  ['minúscula + dígito só', 'abcdefghij12', 'classes'],
  // Passa comprimento (12) e classes (3), mas está na blocklist — o caso que só a
  // blocklist pega, depois que os dois primeiros gates deixaram passar.
  ['comum apesar de complexa', 'Password123!', 'blocklist'],
];

describe('avaliarPolitica — sem contexto', () => {
  it('aprova uma senha forte', () => {
    expect(avaliarPolitica('N0v@Senh@Forte!')).toEqual({ ok: true });
  });

  it.each(REPROVADAS)('reprova %s pelo motivo esperado', (_caso, senha, motivo) => {
    expect(avaliarPolitica(senha)).toEqual({ ok: false, motivo });
  });

  it('reprova senha no comprimento máximo + 1', () => {
    const gigante = `A1!${'a'.repeat(POLITICA.comprimentoMaximo)}`;
    expect(avaliarPolitica(gigante)).toEqual({ ok: false, motivo: 'comprimento' });
  });

  it('aceita exatamente 3 das 4 classes', () => {
    // minúscula + maiúscula + dígito, sem símbolo.
    expect(avaliarPolitica('SenhaForte123')).toEqual({ ok: true });
  });
});

describe('avaliarPolitica — com e-mail no contexto', () => {
  it('reprova senha que contém o local-part do e-mail', () => {
    expect(avaliarPolitica('joaosilva!A1x', { email: 'joaosilva@iam.local' })).toEqual({
      ok: false,
      motivo: 'contem-email',
    });
  });

  it('ignora local-part curto demais para valer a regra', () => {
    // 'ab' tem 2 caracteres (< MIN_LOCAL_PART); não deve reprovar por conter e-mail.
    expect(avaliarPolitica('N0v@Senh@Forte!', { email: 'ab@iam.local' })).toEqual({ ok: true });
  });
});

describe('senhaForte (Zod) concorda com o domínio', () => {
  it.each(['N0v@Senh@Forte!', 'SenhaForte123'])('aceita %j', (senha) => {
    expect(senhaForte.safeParse(senha).success).toBe(true);
  });

  it.each(['curta1!A', 'abcdefghijkl', 'Password123!'])('rejeita %j sem ecoar a senha', (senha) => {
    const resultado = senhaForte.safeParse(senha);

    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      const mensagens = resultado.error.issues.map((i) => i.message).join(' ');
      expect(mensagens).not.toContain(senha);
    }
  });
});
