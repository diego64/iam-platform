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

/**
 * Rede e nomes de serviço do `docker-compose.test.yml`.
 *
 * Dentro do container, `127.0.0.1` é o próprio container: as portas altas publicadas no
 * host (55432/57017) não existem ali. O acesso é pela rede do compose, pelo nome do
 * serviço e pela porta padrão do banco.
 */
const REDE_DO_COMPOSE = 'iam-platform-test_default';
const HOST_POSTGRES = 'postgres:5432';
const HOST_MONGO = 'mongodb:27017';

function opcional(nome: string): string | undefined {
  const valor = process.env[nome];
  return valor === undefined || valor === '' ? undefined : valor;
}

/**
 * Rede em que o container do teste entra.
 *
 * `REDE_E2E` tem precedência para o CI, que pode nomear a rede de outro jeito; o default
 * é a rede que o `pnpm infra:test:up` cria.
 */
function redeDoTeste(): string {
  return opcional('REDE_E2E') ?? REDE_DO_COMPOSE;
}

/**
 * URLs vistas de DENTRO do container, montadas com as mesmas credenciais que o compose
 * de teste consome. Nenhuma credencial literal versionada — o padrão é o mesmo de
 * `tests/integration/helpers/ambiente.ts`.
 *
 * Vazio quando as credenciais não estão no ambiente: nesse caso os casos de ciclo de
 * vida são pulados, em vez de falharem por configuração ausente e mascararem uma
 * regressão real da imagem.
 */
function urlsDosBancos(): { postgres?: string; mongo?: string } {
  const postgresPronta = opcional('POSTGRES_URL_E2E');
  const mongoPronta = opcional('MONGODB_URL_E2E');
  if (postgresPronta !== undefined && mongoPronta !== undefined) {
    return { postgres: postgresPronta, mongo: mongoPronta };
  }

  const usuarioPg = opcional('POSTGRES_USER_TEST');
  const senhaPg = opcional('POSTGRES_PASSWORD_TEST');
  const bancoPg = opcional('POSTGRES_DB_TEST');
  const usuarioMongo = opcional('MONGO_INITDB_ROOT_USERNAME_TEST');
  const senhaMongo = opcional('MONGO_INITDB_ROOT_PASSWORD_TEST');

  if (
    usuarioPg === undefined ||
    senhaPg === undefined ||
    bancoPg === undefined ||
    usuarioMongo === undefined ||
    senhaMongo === undefined
  ) {
    return {};
  }

  return {
    postgres: `postgres://${encodeURIComponent(usuarioPg)}:${encodeURIComponent(senhaPg)}@${HOST_POSTGRES}/${bancoPg}`,
    mongo: `mongodb://${encodeURIComponent(usuarioMongo)}:${encodeURIComponent(senhaMongo)}@${HOST_MONGO}/?authSource=admin`,
  };
}

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
      'O script `pnpm test:e2e` constrói a imagem antes de rodar; para construir à mão, ' +
      '`pnpm docker:build:test`.',
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

const bancos = urlsDosBancos();
const temBancos = bancos.postgres !== undefined && bancos.mongo !== undefined;

if (podeRodar && !temBancos) {
  // eslint-disable-next-line no-console
  console.warn(
    '[e2e] ciclo de vida pulado: credenciais da infra de teste ausentes. ' +
      'Rode `pnpm infra:test:up` e garanta infra/compose/.env — o script test:e2e as carrega.',
  );
}

describe.skipIf(!podeRodar || !temBancos)('imagem de produção — ciclo de vida', () => {
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
      '--network',
      redeDoTeste(),
      '-e',
      `POSTGRES_URL=${bancos.postgres ?? ''}`,
      '-e',
      `MONGODB_URL=${bancos.mongo ?? ''}`,
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
