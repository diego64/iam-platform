/**
 * Cobre as travas da restauração e o expurgo.
 *
 * A propriedade que interessa não é "restaura", e sim **quando o script se recusa a
 * restaurar**: sem confirmação, com checksum adulterado, com o alvo errado na URL ou com o
 * alvo já povoado. Cada uma dessas recusas precisa acontecer antes da primeira escrita —
 * restauração que aborta no meio deixa o banco pior do que estava.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RESTORE = new URL('../../../scripts/restore.sh', import.meta.url).pathname;
const PRUNE = new URL('../../../scripts/backup-prune.sh', import.meta.url).pathname;

let raiz: string;
let artefatos: string;

/** Monta um conjunto de artefatos em claro, com checksums coerentes. */
function semearArtefatos(carimbo = '20260803T030000Z'): void {
  writeFileSync(join(artefatos, `pg-${carimbo}.dump`), 'conteudo-postgres');
  writeFileSync(join(artefatos, `mongo-${carimbo}.archive`), 'conteudo-mongo');
  writeFileSync(
    join(artefatos, `SHA256SUMS-${carimbo}`),
    // Gerado pelo próprio sha256sum no `beforeEach`, para o teste não fixar hash à mão.
    '',
  );
}

interface Execucao {
  readonly codigo: number;
  readonly saida: string;
}

async function shell(
  comando: string,
  argumentos: string[],
  ambiente: Record<string, string> = {},
): Promise<Execucao> {
  try {
    const { stdout, stderr } = await execFileAsync(comando, argumentos, {
      env: { PATH: process.env['PATH'] ?? '', ...ambiente },
    });
    return { codigo: 0, saida: `${stdout}${stderr}` };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function gerarChecksums(carimbo = '20260803T030000Z'): Promise<void> {
  await execFileAsync('bash', [
    '-c',
    `cd "${artefatos}" && sha256sum pg-${carimbo}.dump mongo-${carimbo}.archive > SHA256SUMS-${carimbo}`,
  ]);
}

function restaurar(argumentos: string[], ambiente: Record<string, string> = {}): Promise<Execucao> {
  return shell(RESTORE, ['--dir', artefatos, ...argumentos], {
    POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/iam-drill',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    RESTORE_TARGET_POSTGRES_DB: 'iam-drill',
    RESTORE_TARGET_MONGODB_DB: 'iam_drill',
    ...ambiente,
  });
}

beforeEach(async () => {
  raiz = mkdtempSync(join(tmpdir(), 'recovery-'));
  artefatos = join(raiz, 'artefatos');
  mkdirSync(artefatos);
  semearArtefatos();
  await gerarChecksums();
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('restauração — travas antes da escrita', () => {
  it('sem --confirm descreve o plano e recusa', async () => {
    const resultado = await restaurar([]);

    expect(resultado.codigo).toBe(5);
    expect(resultado.saida).toContain('[plano]');
    expect(resultado.saida).toContain('--confirm');
  });

  it('recusa quando o checksum não confere', async () => {
    appendFileSync(join(artefatos, 'pg-20260803T030000Z.dump'), 'adulterado');

    const resultado = await restaurar(['--confirm']);

    expect(resultado.codigo).toBe(4);
    expect(resultado.saida).toContain('Checksum');
  });

  it('recusa quando não há checksums para conferir', async () => {
    rmSync(join(artefatos, 'SHA256SUMS-20260803T030000Z'));

    const resultado = await restaurar(['--confirm']);

    expect(resultado.codigo).toBe(4);
  });

  it('recusa quando o banco da URL não é o alvo declarado', async () => {
    const resultado = await restaurar(['--confirm'], {
      POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/producao',
    });

    expect(resultado.codigo).toBe(5);
    expect(resultado.saida).toContain('Alvo divergente');
  });

  it('recusa alvo de produção sem a quebra-vidro', async () => {
    const resultado = await restaurar(['--confirm'], {
      POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/iam-prod',
      RESTORE_TARGET_POSTGRES_DB: 'iam-prod',
    });

    expect(resultado.codigo).toBe(5);
    expect(resultado.saida).toContain('RESTORE_ALLOW_PRODUCTION');
  });

  it('recusa diretório sem artefato do banco pedido', async () => {
    rmSync(join(artefatos, 'pg-20260803T030000Z.dump'));
    await execFileAsync('bash', [
      '-c',
      `cd "${artefatos}" && sha256sum mongo-20260803T030000Z.archive > SHA256SUMS-20260803T030000Z`,
    ]);

    const resultado = await restaurar(['--confirm', '--somente', 'pg']);

    expect(resultado.codigo).toBe(2);
  });

  it('recusa parâmetro desconhecido antes de qualquer leitura', async () => {
    const resultado = await restaurar(['--inventado']);

    expect(resultado.codigo).toBe(2);
  });
});

describe('expurgo', () => {
  function semearConjuntos(carimbos: string[]): void {
    for (const carimbo of carimbos) {
      writeFileSync(join(artefatos, `pg-${carimbo}.dump`), 'x');
      writeFileSync(join(artefatos, `mongo-${carimbo}.archive`), 'x');
      writeFileSync(join(artefatos, `manifest-${carimbo}.json`), '{}');
    }
  }

  function conjuntosRestantes(): string[] {
    return readdirSync(artefatos)
      .filter((nome) => nome.startsWith('pg-'))
      .map((nome) => nome.replace(/^pg-(.+)\.dump$/, '$1'))
      .sort();
  }

  it('simula por padrão, sem remover nada', async () => {
    semearConjuntos(['20260101T030000Z', '20260201T030000Z', '20260301T030000Z']);
    const antes = conjuntosRestantes().length;

    const resultado = await shell(PRUNE, [], { DIRETORIO_BACKUP: artefatos });

    expect(resultado.saida).toContain('simulação');
    expect(conjuntosRestantes()).toHaveLength(antes);
  });

  it('preserva o conjunto mais recente mesmo com política de um só', async () => {
    // O `beforeEach` já deixou um conjunto de agosto — ele é o mais recente, e é ele que a
    // trava precisa salvar por mais apertada que seja a política.
    semearConjuntos(['20250101T030000Z', '20250601T030000Z', '20260301T030000Z']);

    await shell(PRUNE, ['--apply'], {
      DIRETORIO_BACKUP: artefatos,
      BACKUP_KEEP_DAILY: '1',
      BACKUP_KEEP_WEEKLY: '1',
      BACKUP_KEEP_MONTHLY: '1',
    });

    expect(conjuntosRestantes()).toContain('20260803T030000Z');
  });

  it('preserva o conjunto validado por ensaio', async () => {
    semearConjuntos(['20250101T030000Z', '20250601T030000Z', '20260301T030000Z']);
    writeFileSync(join(artefatos, '.drill-ok-20250101T030000Z'), '');

    await shell(PRUNE, ['--apply'], {
      DIRETORIO_BACKUP: artefatos,
      BACKUP_KEEP_DAILY: '1',
      BACKUP_KEEP_WEEKLY: '1',
      BACKUP_KEEP_MONTHLY: '1',
    });

    expect(conjuntosRestantes()).toContain('20250101T030000Z');
  });

  it('não remove nada quando só existe um conjunto', async () => {
    const resultado = await shell(PRUNE, ['--apply'], { DIRETORIO_BACKUP: artefatos });

    expect(conjuntosRestantes()).toHaveLength(1);
    expect(resultado.codigo).toBe(0);
  });

  it('recusa parâmetro desconhecido', async () => {
    const resultado = await shell(PRUNE, ['--inventado'], { DIRETORIO_BACKUP: artefatos });

    expect(resultado.codigo).toBe(2);
  });
});
