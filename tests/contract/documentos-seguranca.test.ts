/**
 * Contrato dos documentos de segurança.
 *
 * O threat model e a matriz do OWASP terminam cada linha apontando um arquivo de teste. Sem
 * esta guarda, essa coluna é decoração: um teste renomeado ou apagado deixa a referência
 * pendurada, e o documento continua afirmando que o controle está provado. O modo de falha
 * é o pior possível — nada quebra, e a mentira só aparece numa auditoria.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = new URL('../../', import.meta.url);

function ler(caminho: string): string {
  return readFileSync(new URL(caminho, RAIZ), 'utf8');
}

/** Todo caminho `tests/...` citado no texto, sem repetição. */
function testesCitados(texto: string): string[] {
  return [...new Set([...texto.matchAll(/`(tests\/[^`]+\.test\.ts)`/g)].map((achado) => achado[1]))]
    .filter((caminho): caminho is string => caminho !== undefined)
    .sort();
}

const THREAT_MODEL = ler('security/threat-model/threat-model.md');
const OWASP = ler('security/owasp-api-top10.md');

describe('threat model', () => {
  it('cita testes suficientes para o modelo significar alguma coisa', () => {
    expect(testesCitados(THREAT_MODEL).length).toBeGreaterThan(30);
  });

  it('todo teste citado existe no repositório', () => {
    const ausentes = testesCitados(THREAT_MODEL).filter(
      (caminho) => !existsSync(fileURLToPath(new URL(caminho, RAIZ))),
    );

    expect(ausentes).toEqual([]);
  });

  it('cobre os nove fluxos e a cadeia de suprimento', () => {
    const fluxos = [
      'Login',
      'Emissão e validação de token',
      'Refresh e sessão',
      'OAuth e clientes de API',
      'Segundo fator',
      'Autorização',
      'Chaves de assinatura',
      'Trilha de auditoria',
      'Superfície HTTP e operação',
      'Cadeia de suprimento e implantação',
    ];

    for (const fluxo of fluxos) {
      expect(THREAT_MODEL).toContain(fluxo);
    }
  });

  it('registra os riscos residuais aceitos, cada um com compensatório e teste', () => {
    const residuais = THREAT_MODEL.split('## Riscos residuais aceitos')[1] ?? '';

    // Um risco aceito sem compensatório nomeado é um controle ausente com nome bonito.
    expect(residuais).toContain('falha aberto');
    expect(residuais.match(/\*\*Compensatório:\*\*/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(testesCitados(residuais).length).toBeGreaterThanOrEqual(4);
  });

  it('nomeia o que ficou de fora do modelo', () => {
    expect(THREAT_MODEL).toContain('## Fora do modelo');
  });
});

describe('matriz do OWASP API Top 10', () => {
  it('todo teste citado existe no repositório', () => {
    const ausentes = testesCitados(OWASP).filter(
      (caminho) => !existsSync(fileURLToPath(new URL(caminho, RAIZ))),
    );

    expect(ausentes).toEqual([]);
  });

  it('os dez itens estão presentes', () => {
    for (let numero = 1; numero <= 10; numero += 1) {
      expect(OWASP).toContain(`## API${String(numero)} —`);
    }
  });

  it('todo item aponta pelo menos um teste', () => {
    const semProva: string[] = [];

    for (let numero = 1; numero <= 10; numero += 1) {
      const inicio = OWASP.indexOf(`## API${String(numero)} —`);
      const fim =
        numero === 10
          ? OWASP.indexOf('\n---', inicio)
          : OWASP.indexOf(`## API${String(numero + 1)} —`);
      const secao = OWASP.slice(inicio, fim === -1 ? undefined : fim);

      if (testesCitados(secao).length === 0) semProva.push(`API${String(numero)}`);
    }

    expect(semProva).toEqual([]);
  });

  it('a tabela de resumo tem uma linha por item', () => {
    const resumo = OWASP.split('## Resumo')[1] ?? '';

    for (let numero = 1; numero <= 10; numero += 1) {
      expect(resumo).toContain(`| API${String(numero)} —`);
    }
  });
});

describe('SECURITY.md', () => {
  const seguranca = ler('SECURITY.md');

  it('aponta para documentos que existem', () => {
    const citados = [...seguranca.matchAll(/`(security\/[^`]+)`/g)].map(
      (achado) => achado[1] ?? '',
    );

    expect(citados.length).toBeGreaterThan(0);
    for (const caminho of citados) {
      expect(existsSync(fileURLToPath(new URL(caminho, RAIZ)))).toBe(true);
    }
  });
});
