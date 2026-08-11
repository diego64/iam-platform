/**
 * Contrato de autorização das rotas do ABAC, lido do próprio código de rotas.
 *
 * Um teste de integração prova que *as rotas de hoje* negam sem permissão; este prova a
 * regra estrutural: nenhuma rota do módulo existe sem `verificarAccessToken` **e**
 * `exigirPermissao`. Rota nova que esqueça o guard falha aqui, mesmo que ninguém tenha
 * escrito o teste de integração dela.
 *
 * A separação de fases é o que garante a ordem, e ela importa duas vezes. Com o guard antes
 * da autenticação, chamada sem token responderia 403 em vez de 401 — o cliente não saberia
 * que basta autenticar. E com a autenticação em `preHandler`, ela rodaria **depois** da
 * validação do schema: um chamador anônimo receberia o erro de corpo inválido de uma rota
 * administrativa, aprendendo o formato esperado da superfície protegida. Em `onRequest` a
 * recusa vem antes de qualquer parse.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const rotas = readFileSync(
  new URL('../../src/modules/abac/routes/abac.routes.ts', import.meta.url),
  'utf8',
);

interface RotaLida {
  readonly metodo: string;
  readonly caminho: string;
  /** O que roda em `onRequest` — onde a autenticação precisa estar. */
  readonly onRequest: string;
  /** O que roda em `preHandler` — onde o guard de permissão precisa estar. */
  readonly preHandler: string;
}

/** Uma entrada por rota registrada no arquivo, com os dois ganchos separados. */
function rotasRegistradas(): RotaLida[] {
  const encontradas: RotaLida[] = [];
  const padrao = /tipado\.(get|post|patch|delete|put)\(\s*'([^']+)'/g;
  for (let m = padrao.exec(rotas); m !== null; m = padrao.exec(rotas)) {
    const metodo = m[1] ?? '';
    const caminho = m[2] ?? '';
    // A definição da rota vai até o próximo registro (ou o fim do arquivo).
    const resto = rotas.slice(m.index);
    const proximo = resto.slice(1).search(/tipado\.(get|post|patch|delete|put)\(/);
    const bloco = proximo === -1 ? resto : resto.slice(0, proximo + 1);
    encontradas.push({
      metodo,
      caminho,
      onRequest: /onRequest:\s*([^,\n]*)/.exec(bloco)?.[1] ?? '',
      preHandler: /preHandler:\s*([^,\n]*)/.exec(bloco)?.[1] ?? '',
    });
  }
  return encontradas;
}

const REGISTRADAS = rotasRegistradas();

describe('guards das rotas do ABAC', () => {
  it('todas as rotas do módulo foram encontradas', () => {
    expect(REGISTRADAS.length).toBeGreaterThanOrEqual(6);
    expect(REGISTRADAS.map((r) => r.caminho)).toContain('/policies/evaluate');
  });

  it('nenhuma rota existe sem guard de permissão', () => {
    for (const rota of REGISTRADAS) {
      expect(rota.preHandler, `${rota.metodo} ${rota.caminho} sem preHandler`).not.toBe('');
    }
  });

  it('a autenticação roda em onRequest, antes da validação do schema', () => {
    for (const rota of REGISTRADAS) {
      expect(
        rota.onRequest,
        `${rota.metodo} ${rota.caminho}: autenticação fora de onRequest roda depois da ` +
          'validação, e um chamador anônimo recebe o erro de schema da rota protegida',
      ).toContain('auth');
    }
  });

  it('a autorização roda em preHandler, depois da autenticação', () => {
    for (const rota of REGISTRADAS) {
      // Fases distintas garantem a ordem sem depender da posição no texto: `onRequest`
      // sempre precede `preHandler`. Guard antes da autenticação daria 403 onde devia 401.
      expect(rota.preHandler, `${rota.metodo} ${rota.caminho} sem exigirPermissao`).toContain(
        'exigirPermissao',
      );
      expect(rota.preHandler, `${rota.metodo} ${rota.caminho}: auth duplicada`).not.toContain(
        'auth',
      );
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
