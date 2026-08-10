/**
 * Cobre o recorte de rede que entra no digest do dispositivo.
 *
 * O equilíbrio é o ponto: recortar demais deixa passar o acesso de outro país; recortar de
 * menos avisa toda vez que o celular troca de torre.
 */
import { describe, expect, it } from 'vitest';
import { prefixoDeRede } from '../../../../src/modules/notifications/repositories/known-device.repository.js';

describe('prefixoDeRede', () => {
  it('IPv4 vira /24', () => {
    expect(prefixoDeRede('203.0.113.10')).toBe('203.0.113');
  });

  it('IPs da mesma /24 são o mesmo dispositivo', () => {
    expect(prefixoDeRede('203.0.113.10')).toBe(prefixoDeRede('203.0.113.250'));
  });

  it('IPs de redes diferentes não se confundem', () => {
    expect(prefixoDeRede('203.0.113.10')).not.toBe(prefixoDeRede('198.51.100.10'));
  });

  it('IPv4 mapeado em IPv6 é tratado como IPv4', () => {
    expect(prefixoDeRede('::ffff:203.0.113.10')).toBe('203.0.113');
  });

  it('IPv6 vira /48', () => {
    expect(prefixoDeRede('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3');
  });

  it('IPv6 abreviado devolve o que existe antes da abreviação', () => {
    expect(prefixoDeRede('2001:db8::1')).toBe('2001:db8:');
  });

  it('normaliza caixa e espaço', () => {
    expect(prefixoDeRede(' 2001:DB8:85A3::1 ')).toBe(prefixoDeRede('2001:db8:85a3::1'));
  });

  it('valor inesperado não explode — devolve o que recebeu', () => {
    expect(prefixoDeRede('desconhecido')).toBe('desconhecido');
  });
});
