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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
        // Estes casos exercitam a verificação de conteúdo, não a cifra: sem o destinatário
        // declarado, o script recusaria antes de chegar ao ponto que eles medem.
        BACKUP_PERMITIR_SEM_CIFRA: '1',
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

describe('cifra em repouso', () => {
  /** Stub do `age`: marca o arquivo como cifrado sem precisar do binário real. */
  function criarStubDeAge(): void {
    const age = `#!/usr/bin/env bash
args=("$@")
destino=""
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "-o" ]]; then destino="\${args[i + 1]}"; fi
done
origem="\${args[-1]}"
{ echo "age-encryption.org/v1"; cat "$origem"; } > "$destino"
exit 0
`;
    writeFileSync(join(raiz, 'bin', 'age'), age);
    chmodSync(join(raiz, 'bin', 'age'), 0o755);
  }

  it('recusa gravar sem destinatário declarado', async () => {
    criarStubsDeDump(4096);

    const resultado = await rodar('--all', { BACKUP_PERMITIR_SEM_CIFRA: '' });

    expect(resultado.codigo).toBe(2);
    expect(resultado.saida).toContain('BACKUP_AGE_RECIPIENT');
  });

  it('cifra o artefato quando há destinatário', async () => {
    criarStubsDeDump(4096);
    criarStubDeAge();

    const resultado = await rodar('--all', {
      BACKUP_PERMITIR_SEM_CIFRA: '',
      BACKUP_AGE_RECIPIENT: 'age1exemplo',
    });

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('.dump.age');
    expect(resultado.saida).toContain('.archive.age');
  });

  it('não deixa material em claro no diretório de destino', async () => {
    criarStubsDeDump(4096);
    criarStubDeAge();

    await rodar('--all', { BACKUP_PERMITIR_SEM_CIFRA: '', BACKUP_AGE_RECIPIENT: 'age1exemplo' });

    const arquivos = readdirSync(join(raiz, 'backups'));
    expect(arquivos.filter((nome) => /\.(dump|archive)$/.test(nome))).toEqual([]);
  });
});

describe('manifesto e checksums', () => {
  it('grava o manifesto com os arquivos gerados e o total de bytes', async () => {
    criarStubsDeDump(4096);

    await rodar('--all');

    const arquivos = readdirSync(join(raiz, 'backups'));
    const manifesto = arquivos.find((nome) => nome.startsWith('manifest-'));
    expect(manifesto).toBeDefined();

    const conteudo = JSON.parse(readFileSync(join(raiz, 'backups', manifesto ?? ''), 'utf8')) as {
      bytes: number;
      arquivos: string[];
      cifrado: boolean;
    };
    expect(conteudo.bytes).toBe(8192);
    expect(conteudo.arquivos).toHaveLength(2);
    expect(conteudo.cifrado).toBe(false);
  });

  it('grava os checksums dos artefatos', async () => {
    criarStubsDeDump(4096);

    await rodar('--all');

    const arquivos = readdirSync(join(raiz, 'backups'));
    const somas = arquivos.find((nome) => nome.startsWith('SHA256SUMS-'));
    expect(somas).toBeDefined();
    expect(readFileSync(join(raiz, 'backups', somas ?? ''), 'utf8')).toContain('pg-');
  });

  it('registra o resultado no arquivo de estado', async () => {
    criarStubsDeDump(4096);
    const estado = join(raiz, 'estado.json');

    await rodar('--all', { BACKUP_STATUS_FILE: estado });

    expect(JSON.parse(readFileSync(estado, 'utf8'))).toMatchObject({ resultado: 'ok' });
  });

  it('registra a falha no arquivo de estado quando o artefato é suspeito', async () => {
    criarStubsDeDump(0);
    const estado = join(raiz, 'estado.json');

    await rodar('--all', { BACKUP_STATUS_FILE: estado });

    expect(JSON.parse(readFileSync(estado, 'utf8'))).toMatchObject({ resultado: 'falha' });
  });
});

describe('conferência de artefatos já gerados', () => {
  it('aceita --validate e confere o que existe no diretório', async () => {
    criarStubsDeDump(4096);
    await rodar('--all');

    const resultado = await rodar('--validate');

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('Backup verificado');
  });

  it('sai 1 quando não há nada para validar', async () => {
    const resultado = await rodar('--validate');

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('Nenhum backup encontrado');
  });
});
