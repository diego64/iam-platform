/**
 * Cobre o bootstrap do processo de verdade: sobe `dist/server.js` como processo filho
 * e observa código de saída, saída de log e porta.
 *
 * Por que processo filho e não import: o bootstrap chama process.exit(). Importar o
 * módulo mataria o runner do Vitest, então os caminhos de falha — justamente os que
 * decidem se um container quebrado entra em produção — ficariam sem teste nenhum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { urlMongoDeTeste, urlPostgresDeTeste } from '../helpers/ambiente.js';

const CAMINHO_SERVIDOR = new URL('../../../dist/server.js', import.meta.url).pathname;

/** Porta livre, para não colidir com o ambiente de desenvolvimento. */
async function portaLivre(): Promise<number> {
  return new Promise((resolver) => {
    const servidor = createServer();
    servidor.listen(0, '127.0.0.1', () => {
      const endereco = servidor.address();
      const porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;
      servidor.close(() => {
        resolver(porta);
      });
    });
  });
}

interface Resultado {
  readonly codigo: number | null;
  readonly saida: string;
}

/**
 * Sobe o servidor com o ambiente informado e resolve quando ele morre ou quando
 * `aguardarBoot` detecta que subiu (aí o processo é encerrado pelo teste).
 */
async function executarServidor(
  ambiente: Record<string, string>,
  opcoes: { readonly esperarSubir?: boolean; readonly timeoutMs?: number } = {},
): Promise<Resultado> {
  const { esperarSubir = false, timeoutMs = 20_000 } = opcoes;

  return new Promise((resolver) => {
    const filho = spawn(process.execPath, [CAMINHO_SERVIDOR], {
      env: { PATH: process.env['PATH'] ?? '', ...ambiente },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let saida = '';
    let finalizado = false;

    const encerrar = (codigo: number | null): void => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(limite);
      resolver({ codigo, saida });
    };

    const limite = setTimeout(() => {
      filho.kill('SIGKILL');
      encerrar(null);
    }, timeoutMs);

    const acumular = (pedaco: Buffer): void => {
      saida += pedaco.toString();
      // Subiu: encerra com SIGTERM para exercitar também o shutdown gracioso.
      if (esperarSubir && saida.includes('boot.listening')) {
        filho.kill('SIGTERM');
      }
    };

    filho.stdout.on('data', acumular);
    filho.stderr.on('data', acumular);
    // 'close' e não 'exit': o exit dispara antes dos streams de stdio esvaziarem, e os
    // logs de shutdown chegam depois — resolver no exit perderia justamente a evidência.
    filho.on('close', (codigo) => {
      encerrar(codigo);
    });
  });
}

beforeAll(() => {
  if (!existsSync(CAMINHO_SERVIDOR)) {
    throw new Error('dist/server.js ausente — rode `pnpm build` antes destes testes.');
  }
});

afterAll(() => {
  // nada a limpar: cada teste encerra o processo filho que criou
});

describe('bootstrap — caminho feliz', () => {
  it('conecta em PostgreSQL e MongoDB, garante índices e passa a ouvir', async () => {
    const porta = await portaLivre();
    const resultado = await executarServidor(
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        PORT: String(porta),
        POSTGRES_URL: urlPostgresDeTeste(),
        MONGODB_URL: urlMongoDeTeste(),
        MONGODB_DB: 'iam_sessions_bootstrap',
      },
      { esperarSubir: true },
    );

    expect(resultado.saida).toContain('boot.env_ok');
    expect(resultado.saida).toContain('boot.postgres_ok');
    expect(resultado.saida).toContain('boot.mongo_ok');
    expect(resultado.saida).toContain('boot.indices_ok');
    expect(resultado.saida).toContain('boot.listening');
  });

  it('encerra com código 0 ao receber SIGTERM depois de subir', async () => {
    const porta = await portaLivre();
    const resultado = await executarServidor(
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        PORT: String(porta),
        POSTGRES_URL: urlPostgresDeTeste(),
        MONGODB_URL: urlMongoDeTeste(),
        MONGODB_DB: 'iam_sessions_bootstrap',
      },
      { esperarSubir: true },
    );

    expect(resultado.saida).toContain('shutdown.completed');
    expect(resultado.codigo).toBe(0);
  });
});

describe('bootstrap — configuração inválida', () => {
  it('sai com código 1 quando POSTGRES_URL está ausente, sem abrir socket', async () => {
    const resultado = await executarServidor({
      NODE_ENV: 'test',
      MONGODB_URL: urlMongoDeTeste(),
    });

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('ENV_INVALIDO');
    expect(resultado.saida).toContain('POSTGRES_URL');
    expect(resultado.saida).not.toContain('boot.listening');
  });

  it('não vaza o valor da variável na saída fatal', async () => {
    const resultado = await executarServidor({
      NODE_ENV: 'test',
      POSTGRES_URL: urlPostgresDeTeste(),
      MONGODB_URL: 'ftp://VALOR-QUE-NAO-PODE-VAZAR',
    });

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).not.toContain('VALOR-QUE-NAO-PODE-VAZAR');
    expect(resultado.saida).toContain('MONGODB_URL');
  });
});

describe('bootstrap — dependência inalcançável', () => {
  it('sai com código 1 quando o PostgreSQL não responde, e não passa a ouvir', async () => {
    const porta = await portaLivre();
    const resultado = await executarServidor({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PORT: String(porta),
      // Porta 1: nada escuta ali. O teto de conexão faz falhar rápido.
      POSTGRES_URL: 'postgres://127.0.0.1:1/inexistente',
      MONGODB_URL: urlMongoDeTeste(),
    });

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('boot.postgres_falhou');
    expect(resultado.saida).not.toContain('boot.listening');
  });

  it('sai com código 1 quando o MongoDB não responde', async () => {
    const porta = await portaLivre();
    const resultado = await executarServidor({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PORT: String(porta),
      POSTGRES_URL: urlPostgresDeTeste(),
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    });

    expect(resultado.codigo).toBe(1);
    expect(resultado.saida).toContain('boot.mongo_falhou');
    expect(resultado.saida).not.toContain('boot.listening');
  });
});
