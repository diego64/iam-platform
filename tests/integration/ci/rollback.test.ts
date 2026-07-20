/**
 * Cobre scripts/rollback.sh, que orquestra validação → deploy → smoke.
 *
 * Rollback é acionado quando as coisas já vão mal. Um rollback que falha em silêncio,
 * ou que reverte para um artefato inválido, troca uma falha conhecida por outra
 * desconhecida no pior momento — por isso os testes cobrem a ORDEM das etapas e a
 * interrupção em cada uma delas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RAIZ_SCRIPTS = new URL('../../../scripts/', import.meta.url).pathname;
const DIGEST = `ghcr.io/dono/app@sha256:${'c'.repeat(64)}`;

let raiz: string;

interface Falhas {
  readonly validacao?: number;
  readonly deploy?: number;
  readonly smoke?: number;
}

/**
 * Copia o rollback.sh real para um diretório com os demais scripts substituídos por
 * stubs — assim a orquestração é exercitada de verdade, sem tocar em rede.
 */
function montarScripts(falhas: Falhas = {}): void {
  const trilha = join(raiz, 'chamadas.log');
  mkdirSync(join(raiz, 'scripts'), { recursive: true });

  writeFileSync(
    join(raiz, 'scripts', 'rollback.sh'),
    readFileSync(join(RAIZ_SCRIPTS, 'rollback.sh'), 'utf8'),
  );

  const stub = (nome: string, codigo: number): void => {
    writeFileSync(
      join(raiz, 'scripts', nome),
      `#!/usr/bin/env bash\necho "${nome} $*" >> "${trilha}"\nexit ${String(codigo)}\n`,
    );
    chmodSync(join(raiz, 'scripts', nome), 0o755);
  };

  stub('verify-artifact.sh', falhas.validacao ?? 0);
  stub('render-deploy.sh', falhas.deploy ?? 0);
  stub('healthcheck.sh', falhas.smoke ?? 0);
  chmodSync(join(raiz, 'scripts', 'rollback.sh'), 0o755);
}

function chamadas(): string[] {
  const trilha = join(raiz, 'chamadas.log');
  return existsSync(trilha) ? readFileSync(trilha, 'utf8').split('\n').filter(Boolean) : [];
}

async function rodar(
  imagem: string,
  ambiente: Record<string, string> = {},
): Promise<{ codigo: number; saida: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(join(raiz, 'scripts', 'rollback.sh'), [imagem], {
      env: {
        PATH: process.env['PATH'] ?? '',
        BASE_URL: 'https://exemplo.invalido',
        RENDER_API_KEY: 'chave',
        RENDER_SERVICE_ID: 'srv-1',
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
  raiz = mkdtempSync(join(tmpdir(), 'rollback-'));
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('rollback bem-sucedido', () => {
  it('sai 0 quando validação, deploy e smoke passam', async () => {
    montarScripts();

    const resultado = await rodar(DIGEST);

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('Rollback concluído');
  });

  it('valida, depois implanta, depois confere — nessa ordem', async () => {
    montarScripts();

    await rodar(DIGEST);

    const ordem = chamadas().map((c) => c.split(' ')[0]);
    expect(ordem).toEqual(['verify-artifact.sh', 'render-deploy.sh', 'healthcheck.sh']);
  });

  it('repassa o digest alvo para validação e deploy', async () => {
    montarScripts();

    await rodar(DIGEST);

    expect(chamadas()[0]).toContain(DIGEST);
    expect(chamadas()[1]).toContain(DIGEST);
  });

  it('confere o smoke com retry, não uma tentativa só', async () => {
    montarScripts();

    await rodar(DIGEST);

    // Um serviço recém-revertido leva alguns segundos para responder; smoke sem retry
    // reprovaria um rollback que na verdade deu certo.
    const smoke = chamadas().find((c) => c.startsWith('healthcheck.sh')) ?? '';
    const argumentos = smoke.split(' ').slice(1);
    expect(argumentos.length).toBeGreaterThanOrEqual(2);
  });
});

describe('interrupção em cada etapa', () => {
  it('não implanta quando o digest alvo é inválido', async () => {
    montarScripts({ validacao: 2 });

    const resultado = await rodar(DIGEST);

    // Reverter para um artefato inválido deixaria produção pior do que já está.
    expect(resultado.codigo).toBe(2);
    expect(chamadas().some((c) => c.startsWith('render-deploy.sh'))).toBe(false);
  });

  it('não confere smoke quando o deploy falha', async () => {
    montarScripts({ deploy: 1 });

    const resultado = await rodar(DIGEST);

    expect(resultado.codigo).toBe(1);
    expect(chamadas().some((c) => c.startsWith('healthcheck.sh'))).toBe(false);
  });

  it('falha quando o smoke reprova, mesmo com o deploy live', async () => {
    montarScripts({ smoke: 1 });

    const resultado = await rodar(DIGEST);

    // Rollback sem verificação troca uma falha conhecida por outra desconhecida.
    expect(resultado.codigo).toBe(1);
  });

  it('propaga falha de infraestrutura como 3, não como falha de gate', async () => {
    montarScripts({ deploy: 3 });

    const resultado = await rodar(DIGEST);

    expect(resultado.codigo).toBe(3);
  });
});

describe('entrada inválida', () => {
  it('sai 2 sem imagem, sem chamar nada', async () => {
    montarScripts();

    const resultado = await rodar('');

    expect(resultado.codigo).toBe(2);
    expect(chamadas()).toEqual([]);
  });

  it('falha quando BASE_URL não está definida', async () => {
    montarScripts();

    const resultado = await rodar(DIGEST, { BASE_URL: '' });

    expect(resultado.codigo).not.toBe(0);
  });
});
