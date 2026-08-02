/**
 * Cobre a censura do logger: senha, token e hash não podem chegar à saída, tenham vindo
 * no topo do objeto logado ou dentro do corpo de uma requisição.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { caminhosDeCensura } from '../../../src/shared/logger/redact.js';

/** Captura as linhas JSON emitidas por um logger. */
function capturar(): { linhas: Record<string, unknown>[]; destino: Writable } {
  const linhas: Record<string, unknown>[] = [];
  const destino = new Writable({
    write(pedaco: Buffer, _codificacao, prosseguir): void {
      linhas.push(JSON.parse(pedaco.toString()) as Record<string, unknown>);
      prosseguir();
    },
  });
  return { linhas, destino };
}

describe('censura do logger', () => {
  it('remove senha e token do objeto logado no topo', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { senha: 'S3nh@Secreta!', token: 'reset-abc', outro: 'ok' },
      'password.change',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('S3nh@Secreta!');
    expect(texto).not.toContain('reset-abc');
    expect(texto).toContain('[censurado]');
    // Campo não sensível permanece.
    expect(linhas[0]?.outro).toBe('ok');
  });

  it('remove senha do corpo de requisição (req.body)', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { req: { body: { email: 'a@b.com', senha_nova: 'N0v@Senh@!' } } },
      'incoming',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('N0v@Senh@!');
    expect(texto).toContain('a@b.com'); // e-mail não é segredo aqui
  });

  it('remove password_hash e authorization', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { password_hash: 'scrypt$16384$8$1$x$y', authorization: 'Bearer abc.def.ghi' },
      'evento',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('scrypt$16384');
    expect(texto).not.toContain('Bearer abc.def.ghi');
  });

  it('remove material de chave de assinatura', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { private_key_enc: 'BLOB-CIFRADO-XYZ', master_key: 'MK-SUPER-SECRETA-32-CHARS-000000' },
      'jwks.gerada',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('BLOB-CIFRADO-XYZ');
    expect(texto).not.toContain('MK-SUPER-SECRETA');
    expect(texto).toContain('[censurado]');
  });

  it('os caminhos cobrem os campos sensíveis conhecidos', () => {
    const caminhos = caminhosDeCensura();

    for (const campo of ['senha', 'senha_atual', 'senha_nova', 'token', 'password_hash']) {
      expect(caminhos).toContain(campo);
      expect(caminhos).toContain(`req.body.${campo}`);
    }
    // Campos de material de chave de assinatura.
    for (const campo of ['private_key_enc', 'privateKey', 'master_key', 'd']) {
      expect(caminhos).toContain(campo);
    }
  });
});

describe('censura de credenciais de cliente de API', () => {
  it('remove o segredo em claro vindo do corpo da autenticação', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { req: { body: { client_id: 'cli_publico', client_secret: 'SEGREDO-EM-CLARO' } } },
      'oauth.token',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('SEGREDO-EM-CLARO');
    expect(texto).toContain('[censurado]');
    // O identificador é público e precisa continuar legível para a investigação servir.
    expect(texto).toContain('cli_publico');
  });

  // O hash no log dá material para atacar offline exatamente o que o scrypt protege.
  it('remove o hash e o hash anterior de um cliente logado inteiro', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      {
        cliente: {
          client_id: 'cli_publico',
          secret_hash: 'scrypt$16384$8$1$SALT-SECRETO$HASH-SECRETO',
          previous_secret_hash: 'scrypt$16384$8$1$SALT-ANTIGO$HASH-ANTIGO',
        },
      },
      'clients.rotate',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('HASH-SECRETO');
    expect(texto).not.toContain('HASH-ANTIGO');
  });

  it('cobre também a grafia camelCase, que é como o domínio nomeia os campos', () => {
    const { linhas, destino } = capturar();

    criarLogger({ destino }).info(
      { clientSecret: 'CLARO-CAMEL', secretHash: 'HASH-CAMEL' },
      'clients.create',
    );

    const texto = JSON.stringify(linhas[0]);
    expect(texto).not.toContain('CLARO-CAMEL');
    expect(texto).not.toContain('HASH-CAMEL');
  });

  it('declara os caminhos de cliente na lista de censura', () => {
    const caminhos = caminhosDeCensura();

    for (const campo of ['client_secret', 'secret_hash', 'previous_secret_hash']) {
      expect(caminhos).toContain(campo);
      expect(caminhos).toContain(`*.${campo}`);
      expect(caminhos).toContain(`req.body.${campo}`);
    }
  });
});
