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

  it('os caminhos cobrem os campos sensíveis conhecidos', () => {
    const caminhos = caminhosDeCensura();

    for (const campo of ['senha', 'senha_atual', 'senha_nova', 'token', 'password_hash']) {
      expect(caminhos).toContain(campo);
      expect(caminhos).toContain(`req.body.${campo}`);
    }
  });
});
