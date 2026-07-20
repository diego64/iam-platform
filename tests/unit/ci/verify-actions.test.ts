/**
 * Cobre scripts/verify-actions.sh com um `gh` stubado, sem rede.
 *
 * O script existe porque uma referência a action inexistente só falha dentro do runner —
 * e quando falha, o erro não diz que a versão não existe. O teste garante que ele
 * continua reprovando esse caso, e que não reprova referência legítima.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../../scripts/verify-actions.sh', import.meta.url).pathname;

let raiz: string;

/**
 * Cria um `gh` falso que aprova tudo, menos as refs listadas em `inexistentes`.
 * O script real consulta `gh api repos/<repo>/git/ref/tags/<ref>`.
 */
function criarGhStub(diretorio: string, inexistentes: string[]): void {
  const stub = `#!/usr/bin/env bash
alvo="$*"
for ref in ${inexistentes.map((r) => `"${r}"`).join(' ')}; do
  if [[ "$alvo" == *"$ref"* ]]; then exit 1; fi
done
if [[ "$alvo" == *"releases/latest"* ]]; then echo "v9.9.9"; fi
exit 0
`;
  const caminho = join(diretorio, 'gh');
  writeFileSync(caminho, stub);
  chmodSync(caminho, 0o755);
}

/** Escreve um workflow mínimo com as referências informadas. */
function criarWorkflow(diretorio: string, usos: string[]): void {
  const conteudo = ['name: Teste', 'jobs:', '  j:', '    steps:']
    .concat(usos.map((u) => `      - uses: ${u}`))
    .join('\n');
  writeFileSync(join(diretorio, 'teste.yml'), `${conteudo}\n`);
}

async function rodar(dirWorkflows: string, dirStub: string): Promise<number> {
  try {
    await execFileAsync(SCRIPT, [dirWorkflows], {
      env: { PATH: `${dirStub}:${process.env['PATH'] ?? ''}` },
    });
    return 0;
  } catch (erro) {
    return (erro as { code?: number }).code ?? 1;
  }
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'verify-actions-'));
  mkdirSync(join(raiz, 'workflows'));
  mkdirSync(join(raiz, 'bin'));
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('verify-actions.sh', () => {
  it('aprova quando todas as referências existem', async () => {
    criarWorkflow(join(raiz, 'workflows'), ['actions/checkout@v6', 'pnpm/action-setup@v4']);
    criarGhStub(join(raiz, 'bin'), []);

    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(0);
  });

  it('reprova quando uma referência não existe', async () => {
    criarWorkflow(join(raiz, 'workflows'), [
      'actions/checkout@v6',
      'actions/dependency-review-action@v6',
    ]);
    criarGhStub(join(raiz, 'bin'), ['dependency-review-action']);

    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(1);
  });

  it('reprova mesmo com uma única referência inválida entre várias válidas', async () => {
    criarWorkflow(join(raiz, 'workflows'), [
      'actions/checkout@v6',
      'actions/setup-node@v6',
      'pnpm/action-setup@v4',
      'inexistente/action@v1',
    ]);
    criarGhStub(join(raiz, 'bin'), ['inexistente/action']);

    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(1);
  });

  it('ignora actions locais e de container, que não têm ref para resolver', async () => {
    criarWorkflow(join(raiz, 'workflows'), ['./.github/actions/local', 'docker://alpine:3']);
    criarGhStub(join(raiz, 'bin'), []);

    // Sem nenhuma referência resolvível, o script sai 1 avisando — é o comportamento
    // desejado: diretório sem action é provavelmente caminho errado.
    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(1);
  });

  it('resolve subpath pelo repositório: github/codeql-action/init usa github/codeql-action', async () => {
    criarWorkflow(join(raiz, 'workflows'), ['github/codeql-action/init@v3']);
    criarGhStub(join(raiz, 'bin'), []);

    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(0);
  });

  it('falha quando o diretório não contém workflow algum', async () => {
    criarGhStub(join(raiz, 'bin'), []);

    expect(await rodar(join(raiz, 'workflows'), join(raiz, 'bin'))).toBe(1);
  });
});
