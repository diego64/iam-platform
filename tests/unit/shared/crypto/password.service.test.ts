/**
 * Cobre o `ServicoDeSenha`: formato do hash, round-trip, salt por senha, e a garantia de
 * que senha errada e hash malformado retornam `false` sem lançar.
 *
 * Custo reduzido de propósito (N=2^14): o comportamento é idêntico ao de produção e a
 * suíte não paga o custo de segurança. O custo de produção é exercido à parte, no caso
 * que valida o `maxmem`.
 */
import { describe, expect, it } from 'vitest';
import {
  criarServicoDeSenha,
  type ParametrosScrypt,
} from '../../../../src/shared/crypto/password.service.js';

const CUSTO_TESTE: ParametrosScrypt = { custo: 2 ** 14, blocos: 8, paralelismo: 1 };
const servico = criarServicoDeSenha(CUSTO_TESTE);

describe('gerarHash', () => {
  it('produz o formato scrypt$N$r$p$salt$hash', async () => {
    const hash = await servico.gerarHash('S3nh@Forte!');
    const partes = hash.split('$');

    expect(partes).toHaveLength(6);
    expect(partes[0]).toBe('scrypt');
    expect(partes[1]).toBe(String(2 ** 14));
    expect(partes[2]).toBe('8');
    expect(partes[3]).toBe('1');
    // salt de 32 bytes e hash de 64 bytes em base64.
    expect(Buffer.from(partes[4] ?? '', 'base64')).toHaveLength(32);
    expect(Buffer.from(partes[5] ?? '', 'base64')).toHaveLength(64);
  });

  it('gera hashes diferentes para a mesma senha (salt por senha), ambos válidos', async () => {
    const a = await servico.gerarHash('mesma-senha');
    const b = await servico.gerarHash('mesma-senha');

    expect(a).not.toBe(b);
    expect(await servico.verificar('mesma-senha', a)).toBe(true);
    expect(await servico.verificar('mesma-senha', b)).toBe(true);
  });
});

describe('verificar', () => {
  it('confere a senha correta', async () => {
    const hash = await servico.gerarHash('correta');

    expect(await servico.verificar('correta', hash)).toBe(true);
  });

  it('rejeita a senha errada sem lançar', async () => {
    const hash = await servico.gerarHash('correta');

    await expect(servico.verificar('errada', hash)).resolves.toBe(false);
  });

  it.each([
    ['string vazia', ''],
    ['sem prefixo', '16384$8$1$c2FsdA==$aGFzaA=='],
    ['partes de menos', 'scrypt$16384$8$1$c2FsdA=='],
    ['N não numérico', 'scrypt$x$8$1$c2FsdA==$aGFzaA=='],
    ['salt de tamanho errado', 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
    ['base64 corrompido', 'scrypt$16384$8$1$!!!$!!!'],
  ])('retorna false para hash malformado (%s) sem lançar', async (_caso, malformado) => {
    await expect(servico.verificar('qualquer', malformado)).resolves.toBe(false);
  });

  it('verifica hash gerado com custo diferente do corrente (parâmetros vêm do hash)', async () => {
    // Um hash antigo, de custo menor, precisa continuar verificando: o custo com que ele
    // foi gerado viaja no próprio hash.
    const servicoAntigo = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
    const hashAntigo = await servicoAntigo.gerarHash('legada');

    expect(await servico.verificar('legada', hashAntigo)).toBe(true);
  });
});

describe('maxmem no custo de produção', () => {
  it('não aborta com N=2^15, r=8 — onde o teto default do Node estoura', async () => {
    // Este caso roda no custo REAL de propósito: é o único que exercita o maxmem
    // explícito. Com o teto default (32 MiB), este gerarHash abortaria intermitente.
    const producao = criarServicoDeSenha({ custo: 2 ** 15, blocos: 8, paralelismo: 1 });
    const hash = await producao.gerarHash('S3nh@DeProducao!');

    expect(await producao.verificar('S3nh@DeProducao!', hash)).toBe(true);
  });
});
