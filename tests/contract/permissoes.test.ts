/**
 * Contrato de permissões do GITHUB_TOKEN.
 *
 * Permissão declarada no nível do workflow é herdada por TODOS os jobs. Um `cd.yml`
 * com `contents: write`, `packages: write` e `id-token: write` no topo dá ao job de
 * smoke test o poder de publicar imagem e assinar artefato — poder que ele nunca usa
 * e que um passo comprometido usaria.
 *
 * Estas asserções travam a regressão: escrita só no job que precisa.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRETORIO = new URL('../../.github/workflows/', import.meta.url).pathname;

function ler(arquivo: string): string {
  return readFileSync(join(DIRETORIO, arquivo), 'utf8');
}

function arquivos(): string[] {
  return readdirSync(DIRETORIO).filter((f) => f.endsWith('.yml'));
}

/** Bloco `permissions:` do nível do workflow — sem indentação. */
function permissoesDoWorkflow(arquivo: string): string {
  return /^permissions:\n((?: {2}.*\n)+)/m.exec(ler(arquivo))?.[1] ?? '';
}

/** Blocos `permissions:` declarados dentro de jobs — indentação de 4. */
function permissoesDeJobs(arquivo: string): string[] {
  return [...ler(arquivo).matchAll(/^ {4}permissions:\n((?: {6}.*\n)+)/gm)].map((m) => m[1] ?? '');
}

describe('permissões no nível do workflow', () => {
  it('nenhum workflow concede escrita no topo', () => {
    const infratores = arquivos().filter((f) => permissoesDoWorkflow(f).includes(': write'));

    expect(infratores).toEqual([]);
  });

  it('todo workflow declara permissões explicitamente, em vez de herdar o padrão', () => {
    const semDeclaracao = arquivos().filter((f) => permissoesDoWorkflow(f) === '');

    expect(semDeclaracao).toEqual([]);
  });

  it('o padrão do topo é contents: read', () => {
    for (const arquivo of arquivos()) {
      expect(permissoesDoWorkflow(arquivo)).toContain('contents: read');
    }
  });
});

describe('elevação por job', () => {
  it('os workflows que publicam ou assinam elevam no job, não no topo', () => {
    // cd.yml precisa de packages:write para publicar, id-token:write para assinar
    // e contents:write para criar a release — cada um em seu job.
    const cd = permissoesDeJobs('cd.yml').join('\n');

    // cd.yml publica e assina, então eleva packages e id-token. Deixou de precisar de
    // contents: write quando a criação de release saiu para a etapa de promoção.
    expect(cd).toContain('packages: write');
    expect(cd).toContain('id-token: write');
    expect(cd).not.toContain('contents: write');
    expect(permissoesDoWorkflow('cd.yml')).not.toContain(': write');
  });

  it('security.yml eleva security-events apenas no job de SAST', () => {
    const conteudo = ler('security.yml');
    const sast = /^ {2}sast:\n(?: {4}.*\n| {6}.*\n)+/m.exec(conteudo)?.[0] ?? '';

    expect(sast).toContain('security-events: write');
    expect(permissoesDoWorkflow('security.yml')).not.toContain(': write');
  });

  it('nenhum job eleva id-token, que habilita OIDC, sem assinar de fato', () => {
    for (const arquivo of arquivos()) {
      const conteudo = ler(arquivo);
      if (!conteudo.includes('id-token: write')) continue;

      // Quem pede id-token precisa usar OIDC — na prática, cosign no projeto.
      expect(conteudo).toMatch(/cosign/i);
    }
  });
});
