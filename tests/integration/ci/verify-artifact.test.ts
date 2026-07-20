/**
 * Cobre scripts/verify-artifact.sh com `docker` e `cosign` stubados.
 *
 * Esta validação roda ANTES de backup, migração e tráfego. Se ela falhar tarde, a
 * promoção já terá alterado estado por um artefato que nunca deveria ter sido
 * promovido — por isso os testes verificam não só o código de saída, mas que nenhuma
 * verificação posterior chegou a ser tentada.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../../scripts/verify-artifact.sh', import.meta.url).pathname;
const DIGEST_VALIDO = `ghcr.io/dono/app@sha256:${'b'.repeat(64)}`;

let raiz: string;

interface Stubs {
  /** 'ok' | 'ausente' (manifest unknown) | 'indisponivel' (erro de rede) */
  readonly registry?: 'ok' | 'ausente' | 'indisponivel';
  /** assinatura válida? */
  readonly assinatura?: boolean;
}

function criarStubs({ registry = 'ok', assinatura = true }: Stubs): void {
  const trilha = join(raiz, 'chamadas.log');

  const docker = `#!/usr/bin/env bash
echo "docker $*" >> "${trilha}"
${
  registry === 'ok'
    ? 'echo "{}"; exit 0'
    : registry === 'ausente'
      ? 'echo "manifest unknown" >&2; exit 1'
      : 'echo "dial tcp: connection refused" >&2; exit 1'
}
`;
  const cosign = `#!/usr/bin/env bash
echo "cosign $*" >> "${trilha}"
exit ${assinatura ? '0' : '1'}
`;
  writeFileSync(join(raiz, 'bin', 'docker'), docker);
  writeFileSync(join(raiz, 'bin', 'cosign'), cosign);
  chmodSync(join(raiz, 'bin', 'docker'), 0o755);
  chmodSync(join(raiz, 'bin', 'cosign'), 0o755);
}

function chamadas(): string[] {
  const trilha = join(raiz, 'chamadas.log');
  return existsSync(trilha) ? readFileSync(trilha, 'utf8').split('\n').filter(Boolean) : [];
}

async function rodar(imagem: string): Promise<{ codigo: number; saida: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [imagem], {
      env: { PATH: `${join(raiz, 'bin')}:${process.env['PATH'] ?? ''}` },
    });
    return { codigo: 0, saida: `${stdout}${stderr}` };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'verify-artifact-'));
  mkdirSync(join(raiz, 'bin'));
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('digest promovível', () => {
  it('sai 0 quando formato, registry e assinatura conferem', async () => {
    criarStubs({});

    const resultado = await rodar(DIGEST_VALIDO);

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('promovível');
  });

  it('consulta o registry e verifica a assinatura, nessa ordem', async () => {
    criarStubs({});

    await rodar(DIGEST_VALIDO);

    const registro = chamadas();
    const indiceDocker = registro.findIndex((c) => c.startsWith('docker'));
    const indiceCosign = registro.findIndex((c) => c.startsWith('cosign'));
    expect(indiceDocker).toBeGreaterThanOrEqual(0);
    expect(indiceCosign).toBeGreaterThan(indiceDocker);
  });
});

describe('formato rejeitado sem tocar em nada', () => {
  it.each([
    ['vazio', ''],
    ['tag em vez de digest', 'ghcr.io/dono/app:latest'],
    ['digest curto', `ghcr.io/dono/app@sha256:${'b'.repeat(63)}`],
    ['digest com caractere inválido', `ghcr.io/dono/app@sha256:${'z'.repeat(64)}`],
    ['sem prefixo sha256', `ghcr.io/dono/app@${'b'.repeat(64)}`],
  ])('sai 2 com %s, sem consultar registry nem cosign', async (_caso, imagem) => {
    criarStubs({});

    const resultado = await rodar(imagem);

    expect(resultado.codigo).toBe(2);
    expect(chamadas()).toEqual([]);
  });
});

describe('digest ausente é diferente de registry fora do ar', () => {
  it('sai 2 quando o manifesto não existe — erro de entrada', async () => {
    criarStubs({ registry: 'ausente' });

    const resultado = await rodar(DIGEST_VALIDO);

    expect(resultado.codigo).toBe(2);
    expect(resultado.saida).toContain('não existe');
  });

  it('sai 3 quando o registry está inalcançável — não é culpa do digest', async () => {
    criarStubs({ registry: 'indisponivel' });

    const resultado = await rodar(DIGEST_VALIDO);

    // Tratar indisponibilidade como digest inválido faria a promoção ser recusada por
    // um problema transitório, e mandaria o operador procurar o erro no lugar errado.
    expect(resultado.codigo).toBe(3);
  });

  it('não verifica assinatura se o digest nem existe', async () => {
    criarStubs({ registry: 'ausente' });

    await rodar(DIGEST_VALIDO);

    expect(chamadas().some((c) => c.startsWith('cosign'))).toBe(false);
  });
});

describe('assinatura', () => {
  it('sai 2 quando a assinatura é inválida ou ausente', async () => {
    criarStubs({ assinatura: false });

    const resultado = await rodar(DIGEST_VALIDO);

    // Imagem sem assinatura válida não passou pelos controles ou não veio deste
    // pipeline. Promover assim anula o motivo de a assinatura existir.
    expect(resultado.codigo).toBe(2);
    expect(resultado.saida).toContain('Assinatura');
  });
});
