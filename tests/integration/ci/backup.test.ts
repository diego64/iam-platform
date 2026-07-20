/**
 * Cobre scripts/backup.sh com `pg_dump` e `mongodump` stubados.
 *
 * O ponto que importa: um backup de 0 bytes é indistinguível de um backup bom para
 * quem só checa o código de saída do dump. Antes, a verificação ficava atrás de
 * `--validate` e o pipeline chamava o script sem a flag — o backup pré-deploy podia
 * estar vazio e ninguém saberia até precisar restaurar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../../scripts/backup.sh', import.meta.url).pathname;

let raiz: string;

/**
 * Cria stubs de pg_dump e mongodump que escrevem `bytes` no destino.
 * `bytes: 0` simula o dump que sai 0 mas não produz conteúdo.
 */
function criarStubsDeDump(bytes: number, opcoes: { criarArquivo?: boolean } = {}): void {
  const { criarArquivo = true } = opcoes;
  const conteudo = criarArquivo ? `head -c ${String(bytes)} /dev/zero > "$destino"` : ':';

  const pg = `#!/usr/bin/env bash
destino=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-f" ]]; then destino="$2"; shift; fi
  shift
done
${conteudo}
exit 0
`;
  const mongo = `#!/usr/bin/env bash
destino=""
for arg in "$@"; do
  if [[ "$arg" == --archive=* ]]; then destino="\${arg#--archive=}"; fi
done
${conteudo}
exit 0
`;
  writeFileSync(join(raiz, 'bin', 'pg_dump'), pg);
  writeFileSync(join(raiz, 'bin', 'mongodump'), mongo);
  chmodSync(join(raiz, 'bin', 'pg_dump'), 0o755);
  chmodSync(join(raiz, 'bin', 'mongodump'), 0o755);
}

async function rodar(
  alvo: string,
  ambiente: Record<string, string> = {},
): Promise<{ codigo: number; saida: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [alvo], {
      env: {
        PATH: `${join(raiz, 'bin')}:${process.env['PATH'] ?? ''}`,
        POSTGRES_URL: 'postgres://localhost:5432/x',
        MONGODB_URL: 'mongodb://localhost:27017',
        DIRETORIO_BACKUP: join(raiz, 'backups'),
        ...ambiente,
      },
    });
    return { codigo: 0, saida: `${stdout}${stderr}` };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'backup-'));
  mkdirSync(join(raiz, 'bin'));
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('backup válido', () => {
  it('sai 0 quando os dumps têm conteúdo', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--all');

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('Backup verificado');
  });

  it('reporta o tamanho de cada arquivo gerado', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--all');

    expect(resultado.saida).toContain('4096 bytes');
  });

  it('gera apenas o alvo pedido', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--postgres');

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('pg-');
    expect(resultado.saida).not.toContain('mongo-');
  });
});

describe('backup vazio aborta a promoção', () => {
  it('sai 1 quando o dump produz 0 bytes', async () => {
    criarStubsDeDump(0);

    const resultado = await rodar('--all');

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('suspeito');
  });

  it('sai 1 quando o dump é menor que o mínimo, mesmo não estando vazio', async () => {
    criarStubsDeDump(10);

    const resultado = await rodar('--all');

    expect(resultado.codigo).toBe(1);
  });

  it('sai 1 quando o dump sai 0 mas não cria arquivo algum', async () => {
    criarStubsDeDump(4096, { criarArquivo: false });

    const resultado = await rodar('--all');

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('não foi criado');
  });

  it('verifica sem precisar de flag — o pipeline chamava o script sem --validate', async () => {
    criarStubsDeDump(0);

    // Exatamente a invocação que o CD fazia: sem nenhuma flag de validação.
    const resultado = await rodar('--all');

    expect(resultado.codigo).toBe(1);
  });
});

describe('configuração inválida', () => {
  it('sai 2 com alvo desconhecido', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--tudo');

    expect(resultado.codigo).toBe(2);
  });

  it('falha quando POSTGRES_URL não está definida', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--postgres', { POSTGRES_URL: '' });

    expect(resultado.codigo).not.toBe(0);
  });
});
