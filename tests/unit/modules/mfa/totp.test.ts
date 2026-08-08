/**
 * Cobre o TOTP contra os vetores da RFC 6238 (Apêndice B, SHA-1), a janela de tolerância, o
 * anti-replay por passo, a rejeição de código malformado e a URI `otpauth://`.
 *
 * Os vetores publicados são de 8 dígitos; aqui os códigos têm 6, e os últimos 6 dígitos do
 * valor de 8 são exatamente `binario % 10^6`. Comparar contra eles é comparar contra a RFC.
 */
import { describe, expect, it } from 'vitest';
import {
  DIGITOS,
  PASSO_SEGUNDOS,
  gerarCodigo,
  gerarSegredo,
  montarUriOtpauth,
  passoDe,
  validarCodigo,
} from '../../../../src/modules/mfa/services/totp.js';
import { codificarBase32, decodificarBase32 } from '../../../../src/modules/mfa/services/base32.js';

/** Segredo dos vetores da RFC 6238: "12345678901234567890" em ASCII. */
const SEGREDO_DA_RFC = Buffer.from('12345678901234567890', 'ascii');

/** [segundos desde a época, código de 8 dígitos publicado na RFC]. */
const VETORES: readonly (readonly [number, string])[] = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
];

describe('gerarCodigo', () => {
  it('reproduz os vetores da RFC 6238', () => {
    for (const [segundos, codigoDeOito] of VETORES) {
      const passo = Math.floor(segundos / PASSO_SEGUNDOS);
      expect(gerarCodigo(SEGREDO_DA_RFC, passo)).toBe(codigoDeOito.slice(-DIGITOS));
    }
  });

  it('devolve sempre seis dígitos, com zeros à esquerda quando preciso', () => {
    for (let passo = 0; passo < 200; passo += 1) {
      expect(gerarCodigo(SEGREDO_DA_RFC, passo)).toMatch(/^\d{6}$/);
    }
  });

  it('passos diferentes dão códigos diferentes', () => {
    expect(gerarCodigo(SEGREDO_DA_RFC, 100)).not.toBe(gerarCodigo(SEGREDO_DA_RFC, 101));
  });
});

describe('validarCodigo', () => {
  const AGORA_MS = 1_111_111_111_000;
  const PASSO_ATUAL = passoDe(AGORA_MS);

  it('aceita o código do passo atual', () => {
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL);

    expect(validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS })).toEqual({
      passo: PASSO_ATUAL,
    });
  });

  it('aceita um passo para trás e um para frente', () => {
    for (const deslocamento of [-1, 1]) {
      const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL + deslocamento);

      expect(validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS })).toEqual({
        passo: PASSO_ATUAL + deslocamento,
      });
    }
  });

  it('recusa fora da janela', () => {
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL + 2);

    expect(validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS })).toBeNull();
  });

  it('recusa o passo já usado', () => {
    // O anti-replay da RFC 6238 §5.2: o mesmo código não vale duas vezes, mesmo dentro
    // dos 30 s em que ele continuaria matematicamente correto.
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL);

    expect(
      validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS, passoMinimo: PASSO_ATUAL }),
    ).toBeNull();
  });

  it('recusa qualquer passo anterior ao último usado', () => {
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL - 1);

    expect(
      validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS, passoMinimo: PASSO_ATUAL }),
    ).toBeNull();
  });

  it('aceita o passo seguinte ao último usado', () => {
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL + 1);

    expect(
      validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS, passoMinimo: PASSO_ATUAL }),
    ).toEqual({ passo: PASSO_ATUAL + 1 });
  });

  it('recusa código com dígito trocado', () => {
    const codigo = gerarCodigo(SEGREDO_DA_RFC, PASSO_ATUAL);
    const adulterado = `${codigo.slice(0, 5)}${codigo[5] === '0' ? '1' : '0'}`;

    expect(validarCodigo(SEGREDO_DA_RFC, adulterado, { agoraMs: AGORA_MS })).toBeNull();
  });

  it('recusa código com tamanho errado sem estourar', () => {
    for (const invalido of ['', '12345', '1234567', 'abcdef']) {
      expect(validarCodigo(SEGREDO_DA_RFC, invalido, { agoraMs: AGORA_MS })).toBeNull();
    }
  });

  it('recusa o código de outro segredo', () => {
    const codigo = gerarCodigo(gerarSegredo(), PASSO_ATUAL);

    expect(validarCodigo(SEGREDO_DA_RFC, codigo, { agoraMs: AGORA_MS })).toBeNull();
  });
});

describe('gerarSegredo', () => {
  it('gera 160 bits distintos a cada chamada', () => {
    const a = gerarSegredo();
    const b = gerarSegredo();

    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });
});

describe('montarUriOtpauth', () => {
  it('monta a URI que o autenticador lê', () => {
    const uri = montarUriOtpauth({
      segredo: SEGREDO_DA_RFC,
      emissor: 'iam.example.com',
      conta: 'admin@iam.local',
    });

    expect(uri.startsWith('otpauth://totp/iam.example.com:admin%40iam.local?')).toBe(true);
    const parametros = new URL(uri).searchParams;
    expect(parametros.get('secret')).toBe(codificarBase32(SEGREDO_DA_RFC));
    expect(parametros.get('algorithm')).toBe('SHA1');
    expect(parametros.get('digits')).toBe('6');
    expect(parametros.get('period')).toBe('30');
  });

  it('o segredo da URI decodifica de volta nos mesmos bytes', () => {
    const uri = montarUriOtpauth({
      segredo: SEGREDO_DA_RFC,
      emissor: 'iam',
      conta: 'a@b.com',
    });
    const base32 = new URL(uri).searchParams.get('secret') ?? '';

    expect(decodificarBase32(base32).equals(SEGREDO_DA_RFC)).toBe(true);
  });
});

describe('base32', () => {
  it('ida e volta preserva os bytes', () => {
    for (const tamanho of [1, 2, 3, 4, 5, 10, 20, 32]) {
      const dados = gerarSegredo().subarray(0, tamanho);
      expect(decodificarBase32(codificarBase32(dados)).equals(dados)).toBe(true);
    }
  });

  it('decodifica ignorando caixa, espaço e hífen', () => {
    const codificado = codificarBase32(SEGREDO_DA_RFC);
    const bagunçado = codificado
      .toLowerCase()
      .replace(/(.{4})/g, '$1 ')
      .trim();

    expect(decodificarBase32(bagunçado).equals(SEGREDO_DA_RFC)).toBe(true);
  });

  it('caractere fora do alfabeto falha alto', () => {
    expect(() => decodificarBase32('AAAA1AAA')).toThrow(/base32/);
  });

  it('aceita alfabeto próprio', () => {
    const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const dados = Buffer.from([0, 1, 2, 3, 4]);

    const codificado = codificarBase32(dados, alfabeto);

    expect(codificado).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    expect(decodificarBase32(codificado, alfabeto).equals(dados)).toBe(true);
  });
});
