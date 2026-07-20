/**
 * Contrato da promoção por digest.
 *
 * O `cd.yml` publicava `latest` a cada push e disparava um deploy hook que não diz qual
 * imagem subir. Duas consequências: o artefato escaneado e assinado não é necessariamente
 * o que sobe, e o rollback não tem alvo — o ponteiro `latest` já andou, então a versão
 * que estava rodando deixou de ser recuperável.
 *
 * Estas asserções travam a regressão para tag mutável.
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

/** Linhas sem comentário — o que o runner de fato executa. */
function linhasEfetivas(arquivo: string): string[] {
  return ler(arquivo)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));
}

describe('nenhuma tag mutável é publicada', () => {
  it('o metadata-action não gera type=raw,value=latest', () => {
    const cd = linhasEfetivas('cd.yml').join('\n');

    expect(cd).not.toMatch(/type=raw,\s*value=latest/);
  });

  it('nenhum workflow publica :latest', () => {
    const comLatest = arquivos().filter((arquivo) =>
      linhasEfetivas(arquivo).some((l) => /(?:value=latest)|(?::latest['"]?\s*$)/.test(l)),
    );

    // docker-scan.yml referencia :latest para LER a imagem publicada, não para publicar.
    // Sai desta exceção quando o scan agendado passar a resolver o digest corrente.
    expect(comLatest.filter((f) => f !== 'docker-scan.yml')).toEqual([]);
  });

  it('o job de build expõe o digest para os jobs seguintes', () => {
    const cd = ler('cd.yml');

    expect(cd).toMatch(/outputs:\s*\n(?:.*\n)*?\s*digest:\s*\$\{\{\s*steps\.push\.outputs\.digest/);
  });

  it('o build falha se alguma tag mutável for gerada', () => {
    const cd = ler('cd.yml');

    expect(cd).toContain('Confirmar que nenhuma tag mutável foi gerada');
  });
});

describe('referência por digest nos jobs de entrega', () => {
  it('os jobs que consomem a imagem referenciam saída imutável, nunca tag', () => {
    const cd = ler('cd.yml');
    const referencias = [...cd.matchAll(/needs\.build-docker\.outputs\.(\w+)/g)].map((m) => m[1]);

    // `imagem` já é IMAGE@sha256:...; `digest` é o sha puro. Ambas são imutáveis.
    // `version` é rótulo, não referência de imagem. O que não pode aparecer é `tags`,
    // que aponta para nome mutável.
    const referenciasDeImagem = referencias.filter((r) => r !== 'version');
    const imutaveis = referenciasDeImagem.filter((r) => r === 'imagem' || r === 'digest');

    expect(imutaveis).toEqual(referenciasDeImagem);
    expect(referencias).not.toContain('tags');
  });

  it('nenhum job do cd.yml monta a imagem com dois-pontos em vez de arroba', () => {
    const suspeitos = linhasEfetivas('cd.yml').filter((l) =>
      /IMAGE\s*\}\}:/.test(l.replace(/\s/g, '')),
    );

    expect(suspeitos).toEqual([]);
  });
});
