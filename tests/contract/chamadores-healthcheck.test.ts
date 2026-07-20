/**
 * Contrato dos chamadores de scripts/healthcheck.sh.
 *
 * A assinatura do script já mudou uma vez sem que os chamadores acompanhassem:
 * smoke-test.yml continuou passando `--smoke`, flag que deixara de existir. O argumento
 * virava número de tentativas e produzia `seq: invalid floating point argument` — o
 * retry nunca rodava, e ninguém percebeu porque o script ainda saía 1 no final.
 *
 * Estes testes travam a classe do problema: nenhum chamador passa flag, e todos usam
 * apenas os argumentos posicionais que o script documenta.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = new URL('../../', import.meta.url).pathname;

/** Toda linha que invoca o healthcheck, em workflows e scripts. */
function chamadas(): { origem: string; linha: string }[] {
  const encontradas: { origem: string; linha: string }[] = [];
  const alvos = [
    ...readdirSync(join(RAIZ, '.github/workflows'))
      .filter((f) => f.endsWith('.yml'))
      .map((f) => join('.github/workflows', f)),
    ...readdirSync(join(RAIZ, 'scripts'))
      .filter((f) => f.endsWith('.sh') && f !== 'healthcheck.sh')
      .map((f) => join('scripts', f)),
  ];

  for (const alvo of alvos) {
    for (const linha of readFileSync(join(RAIZ, alvo), 'utf8').split('\n')) {
      if (linha.includes('healthcheck.sh') && !linha.trimStart().startsWith('#')) {
        encontradas.push({ origem: alvo, linha: linha.trim() });
      }
    }
  }
  return encontradas;
}

describe('chamadores do healthcheck.sh', () => {
  it('existe pelo menos um chamador — senão o teste passa por vacuidade', () => {
    expect(chamadas().length).toBeGreaterThan(0);
  });

  it('nenhum chamador passa flag: o script só aceita posicionais', () => {
    const comFlag = chamadas().filter(({ linha }) =>
      / --[a-z]/.test(linha.replace(/--env-file\S*/g, '')),
    );

    expect(comFlag.map((c) => `${c.origem}: ${c.linha}`)).toEqual([]);
  });

  it('os argumentos depois da URL são numéricos, como o script espera', () => {
    for (const { origem, linha } of chamadas()) {
      // Expressões ${{ ... }} e strings entre aspas contêm espaços; colapsar antes de
      // separar, senão a URL vira vários argumentos e o teste acusa falso positivo.
      const depois = (linha.split('healthcheck.sh')[1] ?? '')
        .replace(/\$\{\{[^}]*\}\}/g, 'EXPR')
        .replace(/"[^"]*"/g, 'ARG')
        .replace(/'[^']*'/g, 'ARG');

      const argumentos = depois
        .trim()
        .split(/\s+/)
        .slice(1)
        .filter((a) => a !== '');

      for (const argumento of argumentos) {
        expect(argumento, `${origem}: argumento não numérico "${argumento}"`).toMatch(/^\d+$/);
      }
    }
  });
});

describe('o script valida readiness, não liveness', () => {
  it('consulta /health/ready', () => {
    const script = readFileSync(join(RAIZ, 'scripts/healthcheck.sh'), 'utf8');

    // /health/live responde 200 com os bancos fora: um smoke apontado para ele
    // aprovaria um deploy incapaz de atender.
    expect(script).toContain('/health/ready');
    expect(script).not.toMatch(/ALVO=.*health\/live/);
  });

  it('exige status ready no corpo, não apenas 200', () => {
    const script = readFileSync(join(RAIZ, 'scripts/healthcheck.sh'), 'utf8');

    expect(script).toContain('"status":"ready"');
  });
});
