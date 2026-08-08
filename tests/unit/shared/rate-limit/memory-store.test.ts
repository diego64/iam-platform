/**
 * Cobre o contador em memória: incremento, leitura sem incremento, virada de janela e o
 * fato de que a janela é fixa (o incremento não a empurra para frente).
 */
import { describe, expect, it } from 'vitest';
import { criarContadorEmMemoria } from '../../../../src/shared/rate-limit/memory-store.js';

const JANELA = 60_000;

function comRelogio(): {
  contador: ReturnType<typeof criarContadorEmMemoria>;
  avancar: (ms: number) => void;
} {
  let instante = 1_000_000;
  return {
    contador: criarContadorEmMemoria({ agora: () => instante }),
    avancar: (ms: number) => {
      instante += ms;
    },
  };
}

describe('criarContadorEmMemoria', () => {
  it('conta a partir de 1', async () => {
    const { contador } = comRelogio();

    await expect(contador.incrementar('k', JANELA)).resolves.toMatchObject({ contagem: 1 });
    await expect(contador.incrementar('k', JANELA)).resolves.toMatchObject({ contagem: 2 });
  });

  it('chaves diferentes não compartilham contagem', async () => {
    const { contador } = comRelogio();

    await contador.incrementar('a', JANELA);
    await contador.incrementar('a', JANELA);

    await expect(contador.ler('b')).resolves.toMatchObject({ contagem: 0 });
  });

  it('ler não incrementa', async () => {
    const { contador } = comRelogio();
    await contador.incrementar('k', JANELA);

    await contador.ler('k');
    await contador.ler('k');

    await expect(contador.ler('k')).resolves.toMatchObject({ contagem: 1 });
  });

  it('chave inexistente devolve zero, não erro', async () => {
    const { contador } = comRelogio();

    await expect(contador.ler('nunca-vista')).resolves.toMatchObject({ contagem: 0 });
  });

  it('a janela é fixa: incrementar não empurra o vencimento', async () => {
    const { contador, avancar } = comRelogio();
    const primeiro = await contador.incrementar('k', JANELA);

    avancar(30_000);
    const segundo = await contador.incrementar('k', JANELA);

    expect(segundo?.expiraEm.getTime()).toBe(primeiro?.expiraEm.getTime());
  });

  it('a contagem zera quando a janela vence', async () => {
    const { contador, avancar } = comRelogio();
    await contador.incrementar('k', JANELA);
    await contador.incrementar('k', JANELA);

    avancar(JANELA + 1);

    await expect(contador.ler('k')).resolves.toMatchObject({ contagem: 0 });
    await expect(contador.incrementar('k', JANELA)).resolves.toMatchObject({ contagem: 1 });
  });

  it('não zera antes de a janela vencer', async () => {
    const { contador, avancar } = comRelogio();
    await contador.incrementar('k', JANELA);

    avancar(JANELA - 1);

    await expect(contador.ler('k')).resolves.toMatchObject({ contagem: 1 });
  });
});
