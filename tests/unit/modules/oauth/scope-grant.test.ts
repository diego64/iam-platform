/**
 * Cobre o cálculo de escopo concedido: interseção dos três conjuntos, rebaixamento silencioso
 * pelo lado do sujeito, erro pelo lado do cliente, expansão de curinga e interseção vazia.
 */
import { describe, expect, it } from 'vitest';
import {
  calcularEscopoConcedido,
  formatarEscopo,
} from '../../../../src/modules/oauth/services/scope-grant.js';
import { ErroDeOAuth } from '../../../../src/modules/oauth/errors/oauth-error.js';

describe('calcularEscopoConcedido', () => {
  it('sem escopo solicitado, concede o que o cliente tem e o sujeito cobre', () => {
    const concedido = calcularEscopoConcedido({
      escoposDoCliente: ['orders:read', 'orders:write'],
      autoridadeDoSujeito: ['orders:read', 'orders:write', 'users:read'],
    });

    expect(concedido).toEqual(['orders:read', 'orders:write']);
  });

  it('lista vazia é tratada como ausência de pedido', () => {
    const concedido = calcularEscopoConcedido({
      solicitados: [],
      escoposDoCliente: ['orders:read'],
      autoridadeDoSujeito: ['orders:read'],
    });

    expect(concedido).toEqual(['orders:read']);
  });

  it('recorta ao que foi solicitado', () => {
    const concedido = calcularEscopoConcedido({
      solicitados: ['orders:read'],
      escoposDoCliente: ['orders:read', 'orders:write'],
      autoridadeDoSujeito: ['orders:read', 'orders:write'],
    });

    expect(concedido).toEqual(['orders:read']);
  });

  it('rebaixa em silêncio o que o sujeito não tem', () => {
    // O cliente pode pedir; quem não pode conceder é o usuário. Recusar aqui contaria a
    // quem tem a senha quais permissões aquela conta não tem.
    const concedido = calcularEscopoConcedido({
      solicitados: ['orders:read', 'orders:write'],
      escoposDoCliente: ['orders:read', 'orders:write'],
      autoridadeDoSujeito: ['orders:read'],
    });

    expect(concedido).toEqual(['orders:read']);
  });

  it('rebaixa um superadmin ao escopo do cliente', () => {
    const concedido = calcularEscopoConcedido({
      escoposDoCliente: ['orders:read'],
      autoridadeDoSujeito: ['*'],
    });

    expect(concedido).toEqual(['orders:read']);
  });

  it('expande curinga de recurso do lado do sujeito', () => {
    const concedido = calcularEscopoConcedido({
      solicitados: ['orders:read', 'users:read'],
      escoposDoCliente: ['orders:read', 'users:read'],
      autoridadeDoSujeito: ['orders:*'],
    });

    expect(concedido).toEqual(['orders:read']);
  });

  it('não expande curinga do lado do cliente', () => {
    // `orders:*` como escopo de cliente não existe (o regex da criação o rejeita); se
    // aparecesse, não pode virar autorização para `orders:read`.
    expect(() =>
      calcularEscopoConcedido({
        solicitados: ['orders:read'],
        escoposDoCliente: ['orders:*'],
        autoridadeDoSujeito: ['*'],
      }),
    ).toThrow(ErroDeOAuth);
  });

  it('recusa escopo fora dos escopos do cliente', () => {
    expect(() =>
      calcularEscopoConcedido({
        solicitados: ['users:delete'],
        escoposDoCliente: ['orders:read'],
        autoridadeDoSujeito: ['*'],
      }),
    ).toThrow(expect.objectContaining({ codigo: 'invalid_scope' }) as Error);
  });

  it('recusa quando a interseção fica vazia', () => {
    expect(() =>
      calcularEscopoConcedido({
        escoposDoCliente: ['orders:read'],
        autoridadeDoSujeito: ['users:read'],
      }),
    ).toThrow(expect.objectContaining({ codigo: 'invalid_scope' }) as Error);
  });

  it('remove repetição mantendo a ordem do pedido', () => {
    const concedido = calcularEscopoConcedido({
      solicitados: ['orders:write', 'orders:read', 'orders:write'],
      escoposDoCliente: ['orders:read', 'orders:write'],
      autoridadeDoSujeito: ['*'],
    });

    expect(concedido).toEqual(['orders:write', 'orders:read']);
  });

  it('escopo sem separador não é coberto por curinga de recurso', () => {
    expect(() =>
      calcularEscopoConcedido({
        solicitados: ['orders'],
        escoposDoCliente: ['orders'],
        autoridadeDoSujeito: ['orders:*'],
      }),
    ).toThrow(ErroDeOAuth);
  });
});

describe('formatarEscopo', () => {
  it('junta com espaço, como manda a RFC 6749', () => {
    expect(formatarEscopo(['orders:read', 'orders:write'])).toBe('orders:read orders:write');
  });
});
