/**
 * Contrato dos workflows de segurança.
 *
 * Dois problemas que estes testes travam:
 *
 * 1. Duplicação: os mesmos jobs existiam em ci.yml e security.yml com nomes
 *    diferentes, então cada PR rodava e exibia tudo duas vezes.
 * 2. Vírgula em fluxo YAML: `{ severity: MEDIUM, HIGH, CRITICAL }` não é uma lista —
 *    o valor termina na primeira vírgula e o resto vira chave inválida. O Container
 *    Scan checava apenas MEDIUM e ignorava HIGH e CRITICAL, aparentando proteger.
 *
 * As asserções são sobre o texto, sem parser de YAML: adicionar dependência só para
 * o teste não se justifica, e o que precisa ser verificado é textualmente decidível.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRETORIO = new URL('../../.github/workflows/', import.meta.url).pathname;

/** Workflows que rodam agendados, fora do fluxo de PR — não contam como duplicata. */
const FORA_DO_FLUXO_DE_PR = ['scheduled-security.yml', 'docker-scan.yml', 'cd.yml'];

function ler(arquivo: string): string {
  return readFileSync(join(DIRETORIO, arquivo), 'utf8');
}

function arquivos(): string[] {
  return readdirSync(DIRETORIO).filter((f) => f.endsWith('.yml'));
}

/** Nomes de job: chaves com exatamente dois espaços de indentação. */
function jobsDe(arquivo: string): string[] {
  return [...ler(arquivo).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
    .map((m) => m[1])
    .filter((nome): nome is string => nome !== undefined && nome !== 'push');
}

describe('definição única dos jobs de segurança', () => {
  it('security.yml é reutilizável, invocado por workflow_call', () => {
    expect(ler('security.yml')).toMatch(/^ {2}workflow_call:/m);
  });

  it('ci.yml delega a segurança em vez de redefinir os jobs', () => {
    expect(ler('ci.yml')).toContain('uses: ./.github/workflows/security.yml');
  });

  it('nenhum job de segurança está duplicado entre ci.yml e security.yml', () => {
    const jobsCi = new Set(jobsDe('ci.yml'));
    const duplicados = jobsDe('security.yml').filter((j) => jobsCi.has(j));

    expect(duplicados).toEqual([]);
  });

  it('cada ferramenta de segurança aparece em um único workflow do fluxo de PR', () => {
    for (const ferramenta of [
      'trufflehog',
      'dependency-review-action',
      'semgrep',
      'trivy-action',
    ]) {
      const encontrados = arquivos()
        .filter((f) => !FORA_DO_FLUXO_DE_PR.includes(f))
        .filter((f) => ler(f).includes(ferramenta));

      expect(encontrados).toHaveLength(1);
    }
  });
});

describe('valores de fluxo YAML sem vírgula truncada', () => {
  it('o Trivy recebe HIGH e CRITICAL no mesmo valor, entre aspas', () => {
    const conteudo = ler('security.yml');

    expect(conteudo).toMatch(/severity: *'[^']*HIGH[^']*CRITICAL[^']*'/);
  });

  it('o TruffleHog recebe verified e unknown no mesmo valor, entre aspas', () => {
    const conteudo = ler('security.yml');

    expect(conteudo).toMatch(/extra_args: *'[^']*verified[^']*unknown[^']*'/);
  });

  it('nenhum mapa em fluxo tem valor sem aspas contendo vírgula', () => {
    // Em BLOCO, `severity: MEDIUM,HIGH,CRITICAL` é uma string única e está correto.
    // O estilhaçamento só ocorre em FLUXO, onde a vírgula separa pares chave-valor.
    const infratores: string[] = [];

    for (const arquivo of arquivos()) {
      for (const linha of ler(arquivo).split('\n')) {
        // Só linhas que SÃO um mapa em fluxo de YAML: `chave: { ... }`.
        // Workflows também carregam shell (${VAR}), JavaScript ({ ...spread }) e
        // expressões ${{ }} do Actions — nenhum deles é YAML e todos usam chaves.
        const fluxo = /^\s*[a-z_-]+:\s*\{(.+)\}\s*$/.exec(linha);
        if (fluxo === null) continue;

        for (const par of (fluxo[1] ?? '').split(',')) {
          const valor = par.split(':').slice(1).join(':').trim();
          // Par sem `:` é resto de um valor truncado pela vírgula anterior.
          if (!par.includes(':') && par.trim() !== '') {
            infratores.push(`${arquivo}: ${linha.trim()}`);
            break;
          }
          if (valor !== '' && /[,]/.test(valor) && !/^['"]/.test(valor)) {
            infratores.push(`${arquivo}: ${linha.trim()}`);
            break;
          }
        }
      }
    }

    expect(infratores).toEqual([]);
  });

  it('nenhum passo tem chave em caixa-alta com valor vazio — assinatura da vírgula solta', () => {
    const infratores: string[] = [];

    for (const arquivo of arquivos()) {
      for (const linha of ler(arquivo).split('\n')) {
        if (/^\s+[A-Z][A-Z_]*:\s*$/.test(linha)) infratores.push(`${arquivo}: ${linha.trim()}`);
      }
    }

    expect(infratores).toEqual([]);
  });
});
