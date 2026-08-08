/**
 * Cobre a extração da credencial do cliente: Basic e corpo, os dois juntos, ausência,
 * base64 quebrado, falta de separador e decodificação percent do par.
 */
import { describe, expect, it } from 'vitest';
import { extrairCredencialDeCliente } from '../../../../src/modules/oauth/services/client-credentials.js';
import { ErroDeOAuth } from '../../../../src/modules/oauth/errors/oauth-error.js';

function basic(valor: string): string {
  return `Basic ${Buffer.from(valor, 'utf8').toString('base64')}`;
}

describe('extrairCredencialDeCliente', () => {
  it('lê o par do header Basic', () => {
    expect(extrairCredencialDeCliente(basic('cli_abc:s3gr3d0'), {})).toEqual({
      clientId: 'cli_abc',
      secret: 's3gr3d0',
    });
  });

  it('aceita o esquema em qualquer caixa', () => {
    const cabecalho = basic('cli_abc:s3gr3d0').replace('Basic', 'bAsIc');

    expect(extrairCredencialDeCliente(cabecalho, {}).clientId).toBe('cli_abc');
  });

  it('lê o par do corpo quando não há header', () => {
    expect(
      extrairCredencialDeCliente(undefined, { client_id: 'cli_abc', client_secret: 's3gr3d0' }),
    ).toEqual({ clientId: 'cli_abc', secret: 's3gr3d0' });
  });

  it('decodifica percent-encoding do par', () => {
    expect(extrairCredencialDeCliente(basic('cli%3Aabc:s%2Fg%3Ad0'), {})).toEqual({
      clientId: 'cli:abc',
      secret: 's/g:d0',
    });
  });

  it('separa no primeiro dois-pontos, deixando o resto no segredo', () => {
    expect(extrairCredencialDeCliente(basic('cli_abc:a:b:c'), {}).secret).toBe('a:b:c');
  });

  it('recusa os dois métodos na mesma requisição', () => {
    expect(() =>
      extrairCredencialDeCliente(basic('cli_abc:s3gr3d0'), {
        client_id: 'cli_abc',
        client_secret: 's3gr3d0',
      }),
    ).toThrow(expect.objectContaining({ codigo: 'invalid_request' }) as Error);
  });

  it('recusa quando o corpo traz só o identificador', () => {
    expect(() => extrairCredencialDeCliente(undefined, { client_id: 'cli_abc' })).toThrow(
      expect.objectContaining({ codigo: 'invalid_client' }) as Error,
    );
  });

  it('recusa quando não vem credencial nenhuma', () => {
    expect(() => extrairCredencialDeCliente(undefined, {})).toThrow(
      expect.objectContaining({ codigo: 'invalid_client' }) as Error,
    );
  });

  it('recusa Basic sem separador', () => {
    expect(() => extrairCredencialDeCliente(basic('cli_abc'), {})).toThrow(ErroDeOAuth);
  });

  it('recusa base64 inválido', () => {
    expect(() => extrairCredencialDeCliente('Basic não-é-base64!!', {})).toThrow(ErroDeOAuth);
  });

  it('recusa Basic vazio', () => {
    expect(() => extrairCredencialDeCliente('Basic ', {})).toThrow(ErroDeOAuth);
  });

  it('recusa percent-encoding malformado', () => {
    expect(() => extrairCredencialDeCliente(basic('cli_abc:%zz'), {})).toThrow(ErroDeOAuth);
  });

  it('header de outro esquema é tratado como ausência de Basic', () => {
    expect(() => extrairCredencialDeCliente('Bearer eyJhbGciOi', { client_id: 'cli_abc' })).toThrow(
      expect.objectContaining({ codigo: 'invalid_client' }) as Error,
    );
  });
});
