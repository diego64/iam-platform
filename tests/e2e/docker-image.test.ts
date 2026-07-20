/**
 * Critérios de aceite da imagem de produção, executados contra o container real.
 *
 * Estes casos já haviam sido verificados à mão durante a implementação. Verificação
 * manual não é verificação: não roda no CI e não pega regressão. É por isso que
 * viraram teste.
 *
 * Sem daemon Docker os casos são pulados com motivo explícito — nunca reportados
 * como sucesso.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IMAGEM = process.env['IMAGEM_E2E'] ?? 'iam-platform:test';
const CONTAINER = 'iam-e2e-teste';
const PORTA = 3050;

/** Docker disponível? Sem ele os casos são pulados, não aprovados. */
function temDocker(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A imagem existe localmente? */
function temImagem(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const podeRodar = temDocker() && temImagem();
const descreve = podeRodar ? describe : describe.skip;

if (!podeRodar) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] pulado: daemon Docker ou imagem "${IMAGEM}" indisponível. ` +
      'Rode `pnpm docker:build` (com a tag iam-platform:test) para exercitar estes casos.',
  );
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

descreve('imagem de produção — superfície', () => {
  it('roda como usuário não-root', async () => {
    const usuario = await docker('run', '--rm', '--entrypoint', 'whoami', IMAGEM);

    expect(usuario).toBe('iam');
  });

  it('não carrega gerenciador de pacote no runtime', async () => {
    const saida = await docker(
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGEM,
      '-c',
      'command -v npm npx corepack pnpm 2>/dev/null | wc -l',
    );

    expect(saida).toBe('0');
  });

  it('não carrega devDependencies após o prune', async () => {
    const saida = await docker(
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGEM,
      '-c',
      'ls node_modules | grep -cE "^(vitest|typescript|eslint|husky)$" || true',
    );

    expect(saida).toBe('0');
  });

  it('expõe apenas o manifesto mínimo, sem a árvore de devDependencies', async () => {
    const manifesto = JSON.parse(
      await docker('run', '--rm', '--entrypoint', 'cat', IMAGEM, 'package.json'),
    ) as Record<string, unknown>;

    expect(manifesto['type']).toBe('module');
    expect(manifesto).not.toHaveProperty('devDependencies');
    expect(manifesto).not.toHaveProperty('scripts');
  });

  it('cabe no limite de tamanho da SPEC (250 MB)', async () => {
    const bytes = Number(await docker('image', 'inspect', IMAGEM, '--format', '{{.Size}}'));

    expect(bytes / 1024 / 1024).toBeLessThan(250);
  });

  it('não guarda .env, .pem ou .git em nenhuma camada', async () => {
    const historico = await docker('history', '--no-trunc', IMAGEM);

    // Filtra a linha do HEALTHCHECK, que cita process.env legitimamente.
    const camadas = historico
      .split('\n')
      .filter((linha) => !linha.includes('HEALTHCHECK'))
      .join('\n');

    expect(camadas).not.toMatch(/\.pem|\.env\b|COPY .*\.git/);
  });
});

descreve('imagem de produção — configuração ausente', () => {
  it('morre com código 1 e não fica healthy quando falta POSTGRES_URL', async () => {
    let codigo = 0;
    try {
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-e',
        'MONGODB_URL=mongodb://127.0.0.1:27017',
        IMAGEM,
      ]);
    } catch (erro) {
      codigo = (erro as { code?: number }).code ?? 0;
    }

    expect(codigo).toBe(1);
  }, 30_000);

  it('reporta a variável ausente sem imprimir valores', async () => {
    let saida = '';
    try {
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-e',
        'MONGODB_URL=mongodb://127.0.0.1:27017',
        '-e',
        'POSTGRES_URL=ftp://VALOR-SIGILOSO',
        IMAGEM,
      ]);
    } catch (erro) {
      const e = erro as { stdout?: string; stderr?: string };
      saida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    expect(saida).toContain('ENV_INVALIDO');
    expect(saida).toContain('POSTGRES_URL');
    expect(saida).not.toContain('VALOR-SIGILOSO');
  }, 30_000);
});

describe.skipIf(!podeRodar)('imagem de produção — ciclo de vida', () => {
  beforeAll(async () => {
    await execFileAsync('docker', ['rm', '-f', CONTAINER]).catch(() => undefined);
    await docker(
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-p',
      `${String(PORTA)}:3000`,
      // Entra na rede do compose de teste: dentro do container, 127.0.0.1 é o próprio
      // container, então os bancos só são alcançáveis pelo nome de serviço da rede.
      ...(process.env['REDE_E2E'] !== undefined ? ['--network', process.env['REDE_E2E']] : []),
      // Sem bancos alcançáveis o boot falha; estes casos exigem a infra de teste no ar.
      '-e',
      `POSTGRES_URL=${process.env['POSTGRES_URL_E2E'] ?? ''}`,
      '-e',
      `MONGODB_URL=${process.env['MONGODB_URL_E2E'] ?? ''}`,
      '-e',
      'MONGODB_DB=iam_sessions_e2e',
      IMAGEM,
    );
  }, 60_000);

  afterAll(async () => {
    await execFileAsync('docker', ['rm', '-f', CONTAINER]).catch(() => undefined);
  });

  it('responde 200 em /health/live e fica healthy', async () => {
    const prazo = Date.now() + 40_000;
    let corpo = '';
    let saudavel = '';

    while (Date.now() < prazo) {
      try {
        const resposta = await fetch(`http://127.0.0.1:${String(PORTA)}/health/live`);
        if (resposta.ok) {
          corpo = await resposta.text();
          saudavel = await docker('inspect', '--format', '{{.State.Health.Status}}', CONTAINER);
          if (saudavel === 'healthy') break;
        }
      } catch {
        // ainda subindo
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    expect(corpo).toContain('"status":"ok"');
    expect(saudavel).toBe('healthy');
  }, 60_000);

  it('encerra com código 0 ao receber SIGTERM', async () => {
    await docker('stop', CONTAINER);
    const codigo = await docker('inspect', '--format', '{{.State.ExitCode}}', CONTAINER);
    const logs = await docker('logs', CONTAINER);

    expect(codigo).toBe('0');
    expect(logs).toContain('shutdown.completed');
  }, 40_000);
});
