/**
 * Contrato de autorização das rotas do ABAC, lido do próprio código de rotas.
 *
 * Um teste de integração prova que *as rotas de hoje* negam sem permissão; este prova a
 * regra estrutural: nenhuma rota do módulo existe sem `verificarAccessToken` seguido de
 * `exigirPermissao`, e a ordem é essa. Rota nova que esqueça o guard falha aqui, mesmo que
 * ninguém tenha escrito o teste de integração dela.
 *
 * A ordem importa: com o guard antes da autenticação, uma chamada sem token responderia 403
 * em vez de 401 — o cliente não saberia que basta autenticar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const rotas = readFileSync(
  new URL('../../src/modules/abac/routes/abac.routes.ts', import.meta.url),
  'utf8',
);

/** `['post', "'/policies'"]` para cada rota registrada no arquivo. */
function rotasRegistradas(): { metodo: string; caminho: string; preHandler: string }[] {
  const encontradas: { metodo: string; caminho: string; preHandler: string }[] = [];
  const padrao = /tipado\.(get|post|patch|delete|put)\(\s*'([^']+)'/g;
  for (let m = padrao.exec(rotas); m !== null; m = padrao.exec(rotas)) {
    const metodo = m[1] ?? '';
    const caminho = m[2] ?? '';
    // A definição da rota vai até o próximo registro (ou o fim do arquivo).
    const resto = rotas.slice(m.index);
    const proximo = resto.slice(1).search(/tipado\.(get|post|patch|delete|put)\(/);
    const bloco = proximo === -1 ? resto : resto.slice(0, proximo + 1);
    const linha = /preHandler:\s*\[([^\]]*)\]/.exec(bloco);
    encontradas.push({ metodo, caminho, preHandler: linha?.[1] ?? '' });
  }
  return encontradas;
}

const REGISTRADAS = rotasRegistradas();

describe('guards das rotas do ABAC', () => {
  it('todas as rotas do módulo foram encontradas', () => {
    expect(REGISTRADAS.length).toBeGreaterThanOrEqual(6);
    expect(REGISTRADAS.map((r) => r.caminho)).toContain('/policies/evaluate');
  });

  it('nenhuma rota existe sem preHandler', () => {
    for (const rota of REGISTRADAS) {
      expect(rota.preHandler, `${rota.metodo} ${rota.caminho} sem preHandler`).not.toBe('');
    }
  });

  it('autenticação vem antes da autorização em toda rota', () => {
    for (const rota of REGISTRADAS) {
      const posicaoAuth = rota.preHandler.indexOf('auth');
      const posicaoGuard = rota.preHandler.indexOf('exigirPermissao');
      expect(
        posicaoAuth,
        `${rota.metodo} ${rota.caminho} sem verificarAccessToken`,
      ).toBeGreaterThan(-1);
      expect(posicaoGuard, `${rota.metodo} ${rota.caminho} sem exigirPermissao`).toBeGreaterThan(
        -1,
      );
      expect(
        posicaoAuth,
        `${rota.metodo} ${rota.caminho}: guard antes da autenticação daria 403 onde devia dar 401`,
      ).toBeLessThan(posicaoGuard);
    }
  });

  it('toda escrita exige policies:write ou policies:delete (BFLA)', () => {
    const escritas = REGISTRADAS.filter(
      (r) => r.metodo !== 'get' && r.caminho !== '/policies/evaluate',
    );
    expect(escritas.length).toBeGreaterThanOrEqual(3);
    for (const rota of escritas) {
      expect(
        /exigirPermissao\('policies:(write|delete)'\)/.test(rota.preHandler),
        `${rota.metodo} ${rota.caminho} sem permissão de escrita`,
      ).toBe(true);
    }
  });

  it('leitura e simulação exigem policies:read', () => {
    const leituras = REGISTRADAS.filter(
      (r) => r.metodo === 'get' || r.caminho === '/policies/evaluate',
    );
    for (const rota of leituras) {
      expect(
        rota.preHandler.includes("exigirPermissao('policies:read')"),
        `${rota.metodo} ${rota.caminho} sem policies:read`,
      ).toBe(true);
    }
  });

  it('o DELETE de política exige a permissão de delete, não a de write', () => {
    const remocao = REGISTRADAS.find((r) => r.metodo === 'delete');
    expect(remocao?.preHandler).toContain("exigirPermissao('policies:delete')");
  });
});
