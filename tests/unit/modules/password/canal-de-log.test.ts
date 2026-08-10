/**
 * Cobre o canal de log-fallback: avisa o pedido de reset sem entregar nada e, sobretudo,
 * sem logar o token — que é a credencial e derrotaria o sha256 no banco se vazasse — nem o
 * endereço de quem pediu.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { criarLogger } from '../../../../src/shared/logger/index.js';
import { criarCanalDeLog } from '../../../../src/modules/password/services/canal-de-log.js';

function capturar(): { linhas: string[]; destino: Writable } {
  const linhas: string[] = [];
  const destino = new Writable({
    write(pedaco: Buffer, _cod, prosseguir): void {
      linhas.push(pedaco.toString());
      prosseguir();
    },
  });
  return { linhas, destino };
}

describe('criarCanalDeLog', () => {
  it('registra o pedido sem incluir o token nem o endereço', async () => {
    const { linhas, destino } = capturar();
    const canal = criarCanalDeLog(criarLogger({ nivel: 'warn', destino }));

    await canal.enviarReset('user@iam.local', 'token-secreto-abc');

    const saida = linhas.join('');
    expect(saida).toContain('log-fallback');
    expect(saida).not.toContain('token-secreto-abc');
    // Ambiente sem canal real é justamente onde ninguém olha para o que o log acumula.
    expect(saida).not.toContain('user@iam.local');
  });

  it('não lança — canal indisponível não derruba o fluxo de reset', async () => {
    const canal = criarCanalDeLog(criarLogger({ nivel: 'fatal' }));

    await expect(canal.enviarReset('a@b.com', 'x')).resolves.toBeUndefined();
  });
});
