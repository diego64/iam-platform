/**
 * Cobre scripts/healthcheck.sh, reutilizado pelo smoke test do pipeline (SPEC 023).
 * Um smoke que aprova ambiente quebrado é pior que não ter smoke nenhum.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../scripts/healthcheck.sh', import.meta.url).pathname;

interface Execucao {
  readonly codigo: number;
  readonly saida: string;
}

async function rodarSmoke(base: string, tentativas = 2, intervalo = 1): Promise<Execucao> {
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [
      base,
      String(tentativas),
      String(intervalo),
    ]);
    return { codigo: 0, saida: `${stdout}${stderr}` };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Servidor de mentira que devolve o que o teste mandar. */
async function servidorFalso(
  responder: (url: string) => { status: number; corpo: string },
): Promise<{ base: string; fechar: () => Promise<void> }> {
  const servidor: Server = createServer((requisicao, resposta) => {
    const { status, corpo } = responder(requisicao.url ?? '');
    resposta.writeHead(status, { 'content-type': 'application/json' });
    resposta.end(corpo);
  });

  await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const endereco = servidor.address();
  const porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;

  return {
    base: `http://127.0.0.1:${String(porta)}`,
    fechar: () =>
      new Promise<void>((resolver) => {
        servidor.close(() => {
          resolver();
        });
      }),
  };
}

describe('healthcheck.sh', () => {
  it('sai 0 quando o readiness responde 200 com status ready', async () => {
    const { base, fechar } = await servidorFalso(() => ({
      status: 200,
      corpo: JSON.stringify({
        status: 'ready',
        dependencias: [{ nome: 'postgres', estado: 'up', duracao_ms: 2 }],
      }),
    }));

    try {
      const resultado = await rodarSmoke(base);
      expect(resultado.codigo).toBe(0);
      expect(resultado.saida).toContain('OK');
    } finally {
      await fechar();
    }
  }, 30_000);

  it('sai diferente de 0 contra URL morta, dentro do número de tentativas', async () => {
    const resultado = await rodarSmoke('http://127.0.0.1:59999', 2, 1);

    expect(resultado.codigo).not.toBe(0);
    expect(resultado.saida).toContain('FALHA');
  }, 30_000);

  it('REPROVA 200 com corpo de erro — o caso que -f sozinho deixaria passar', async () => {
    const { base, fechar } = await servidorFalso(() => ({
      status: 200,
      corpo: JSON.stringify({ status: 'degradado', erro: 'banco fora' }),
    }));

    try {
      const resultado = await rodarSmoke(base, 2, 1);
      expect(resultado.codigo).not.toBe(0);
      expect(resultado.saida).toContain('corpo inesperado');
    } finally {
      await fechar();
    }
  }, 30_000);

  it('reprova 503', async () => {
    const { base, fechar } = await servidorFalso(() => ({
      status: 503,
      corpo: JSON.stringify({ status: 'indisponivel' }),
    }));

    try {
      const resultado = await rodarSmoke(base, 2, 1);
      expect(resultado.codigo).not.toBe(0);
    } finally {
      await fechar();
    }
  }, 30_000);

  it('REPROVA ambiente onde só o liveness responde', async () => {
    // O cenário que a ausência de homologação torna possível chegar a produção: o
    // processo sobe, /health/live responde 200, e o serviço não consegue falar com o
    // banco. Enquanto o smoke apontava para liveness, isso passava.
    const { base, fechar } = await servidorFalso((url) =>
      url.includes('/health/live')
        ? { status: 200, corpo: JSON.stringify({ status: 'ok', uptime_seconds: 5 }) }
        : { status: 503, corpo: JSON.stringify({ title: 'Serviço indisponível' }) },
    );

    try {
      const resultado = await rodarSmoke(base, 2, 1);
      expect(resultado.codigo).not.toBe(0);
    } finally {
      await fechar();
    }
  }, 30_000);

  it('REPROVA readiness que responde 200 mas sem status ready', async () => {
    // 200 com corpo inesperado é o caso que `curl -f` sozinho deixaria passar.
    const { base, fechar } = await servidorFalso(() => ({
      status: 200,
      corpo: JSON.stringify({ status: 'ok' }),
    }));

    try {
      const resultado = await rodarSmoke(base, 2, 1);
      expect(resultado.codigo).not.toBe(0);
      expect(resultado.saida).toContain('corpo inesperado');
    } finally {
      await fechar();
    }
  }, 30_000);

  it('consulta /health/ready, não /health/live', async () => {
    const consultadas: string[] = [];
    const { base, fechar } = await servidorFalso((url) => {
      consultadas.push(url);
      return {
        status: 200,
        corpo: JSON.stringify({ status: 'ready', dependencias: [] }),
      };
    });

    try {
      await rodarSmoke(base);
      expect(consultadas.some((u) => u.includes('/health/ready'))).toBe(true);
      expect(consultadas.some((u) => u.includes('/health/live'))).toBe(false);
    } finally {
      await fechar();
    }
  }, 30_000);

  it('exige a URL base como argumento', async () => {
    const resultado = await execFileAsync(SCRIPT, []).then(
      () => ({ codigo: 0 }),
      (erro: unknown) => ({ codigo: (erro as { code?: number }).code ?? 1 }),
    );

    expect(resultado.codigo).not.toBe(0);
  });
});
