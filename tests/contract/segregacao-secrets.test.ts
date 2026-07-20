/**
 * Contrato de segregação de secrets.
 *
 * Sem ambiente de homologação, a aprovação no Environment `producao` é a única barreira
 * entre um artefato e o tráfego. Essa barreira só vale se os secrets estiverem NO
 * environment: secret de repositório é legível por qualquer job de qualquer workflow,
 * então a aprovação não protegeria nada — o job de lint alcançaria o banco de produção.
 *
 * Estas asserções travam a regressão no lado do código. A configuração em si
 * (required reviewers, secrets do environment) vive no GitHub e é verificada por
 * `gh api`, não aqui.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRETORIO = new URL('../../.github/workflows/', import.meta.url).pathname;

/** Secrets que só podem ser referenciados por job com `environment: producao`. */
const SECRETS_PROTEGIDOS = [
  'POSTGRES_URL',
  'MONGODB_URL',
  'BASE_URL',
  'RENDER_API_KEY',
  'RENDER_SERVICE_ID',
];

function ler(arquivo: string): string {
  return readFileSync(join(DIRETORIO, arquivo), 'utf8');
}

function arquivos(): string[] {
  return readdirSync(DIRETORIO).filter((f) => f.endsWith('.yml'));
}

/** Blocos de job, do cabeçalho até o próximo job de mesma indentação. */
function jobsDe(arquivo: string): { nome: string; corpo: string }[] {
  const conteudo = ler(arquivo);
  const cabecalhos = [...conteudo.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];

  return cabecalhos.map((m, i) => {
    const inicio = m.index;
    const fim = cabecalhos[i + 1]?.index ?? conteudo.length;
    return { nome: m[1] ?? '', corpo: conteudo.slice(inicio, fim) };
  });
}

describe('secrets protegidos só em job aprovado', () => {
  it('todo job que referencia secret protegido declara environment: producao', () => {
    const infratores: string[] = [];

    for (const arquivo of arquivos()) {
      for (const { nome, corpo } of jobsDe(arquivo)) {
        const usa = SECRETS_PROTEGIDOS.some((s) => corpo.includes(`secrets.${s}`));
        if (!usa) continue;

        if (!/^ {4}environment: *producao/m.test(corpo)) {
          infratores.push(`${arquivo}:${nome}`);
        }
      }
    }

    expect(infratores).toEqual([]);
  });

  it('o cd.yml não referencia secret protegido — ele não implanta', () => {
    const cd = ler('cd.yml');

    for (const secret of SECRETS_PROTEGIDOS) {
      expect(cd).not.toContain(`secrets.${secret}`);
    }
  });

  it('o job de validação da promoção não usa secret protegido', () => {
    // A validação roda antes da aprovação de propósito: o operador descobre que o
    // digest é inválido sem precisar acordar um reviewer. Para isso, ela não pode
    // depender de nada que só exista atrás da aprovação.
    const validar = jobsDe('promote.yml').find((j) => j.nome === 'validar');

    expect(validar).toBeDefined();
    for (const secret of SECRETS_PROTEGIDOS) {
      expect(validar?.corpo ?? '').not.toContain(`secrets.${secret}`);
    }
  });

  it('o job que promove declara o environment', () => {
    const promover = jobsDe('promote.yml').find((j) => j.nome === 'promover');

    expect(promover?.corpo ?? '').toMatch(/^ {4}environment: *producao/m);
  });
});

describe('nenhum secret é impresso', () => {
  it('nenhum workflow ecoa um secret protegido', () => {
    const infratores: string[] = [];

    for (const arquivo of arquivos()) {
      for (const linha of ler(arquivo).split('\n')) {
        if (!/echo|printf/.test(linha)) continue;
        if (SECRETS_PROTEGIDOS.some((s) => linha.includes(`secrets.${s}`))) {
          infratores.push(`${arquivo}: ${linha.trim()}`);
        }
      }
    }

    expect(infratores).toEqual([]);
  });

  it('nenhum workflow ativa rastreamento de shell, que imprimiria secrets', () => {
    const infratores = arquivos().filter((arquivo) =>
      ler(arquivo)
        .split('\n')
        .some((l) => /^\s*set +-[a-z]*x/.test(l)),
    );

    expect(infratores).toEqual([]);
  });
});
