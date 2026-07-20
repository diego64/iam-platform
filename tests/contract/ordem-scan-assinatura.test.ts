/**
 * Contrato da ordem entre scan e assinatura.
 *
 * O `cd.yml` assinava antes de escanear. Assinatura é atestado de que o artefato passou
 * pelos controles; produzida antes do scan, ela atesta algo não verificado — e uma imagem
 * reprovada no Trivy ficava assinada no registry, com a assinatura significando apenas
 * "foi construída aqui".
 *
 * Um consumidor que confere `cosign verify` antes de rodar a imagem estaria confiando
 * numa garantia que não existe.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const CD = readFileSync(new URL('../../.github/workflows/cd.yml', import.meta.url), 'utf8');

/** Dependências declaradas por um job. */
function needsDe(job: string): string[] {
  const bloco =
    new RegExp(`^ {2}${job}:\\n(?: {4}.*\\n| {6}.*\\n| *\\n)*`, 'm').exec(CD)?.[0] ?? '';
  const needs = /^ {4}needs:\s*\[(.+)\]/m.exec(bloco)?.[1] ?? '';
  return needs
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
}

describe('ordem build → scan → assinatura', () => {
  it('o scan depende apenas do build, não da assinatura', () => {
    const needs = needsDe('trivy-scan');

    expect(needs).toContain('build-docker');
    expect(needs).not.toContain('cosign-sign');
  });

  it('a assinatura depende do scan', () => {
    expect(needsDe('cosign-sign')).toContain('trivy-scan');
  });

  it('nada entre o scan e a assinatura pode inverter a cadeia', () => {
    // Transitivamente: qualquer caminho de cosign-sign até build-docker passa por trivy-scan.
    const visitados = new Set<string>();
    const fila = [...needsDe('cosign-sign')];
    while (fila.length > 0) {
      const atual = fila.shift();
      if (atual === undefined || visitados.has(atual)) continue;
      visitados.add(atual);
      fila.push(...needsDe(atual));
    }

    expect(visitados).toContain('trivy-scan');
    expect(visitados).toContain('build-docker');
  });
});

describe('severidade bloqueante do scan', () => {
  it('o Trivy bloqueia HIGH e CRITICAL', () => {
    expect(CD).toMatch(/severity: *'[^']*HIGH[^']*CRITICAL[^']*'/);
  });

  it('o Trivy sai 1 em achado, para o gate reprovar de fato', () => {
    expect(CD).toMatch(/exit-code: *'1'/);
  });

  it('o scan usa a imagem por digest, não por tag', () => {
    const bloco = /^ {2}trivy-scan:\n(?: {4}.*\n| {6}.*\n| {8}.*\n| *\n)*/m.exec(CD)?.[0] ?? '';

    expect(bloco).toContain('outputs.imagem');
    expect(bloco).not.toMatch(/image-ref:.*:latest/);
  });
});

describe('o deploy só ocorre depois da cadeia completa', () => {
  it('todo caminho até o deploy passa por scan e assinatura', () => {
    const visitados = new Set<string>();
    const fila = [...needsDe('deploy')];
    while (fila.length > 0) {
      const atual = fila.shift();
      if (atual === undefined || visitados.has(atual)) continue;
      visitados.add(atual);
      fila.push(...needsDe(atual));
    }

    expect(visitados).toContain('trivy-scan');
    expect(visitados).toContain('cosign-sign');
  });
});
