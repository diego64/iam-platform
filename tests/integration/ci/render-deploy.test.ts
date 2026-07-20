/**
 * Cobre scripts/render-deploy.sh contra uma API do Render simulada.
 *
 * Sem ambiente de ensaio, este é o teste mais próximo do real que existe: o caminho de
 * promoção de verdade só roda em produção, com aprovação. Então a lógica precisa estar
 * provada aqui — sequência de chamadas, espera por estado terminal e, principalmente,
 * a distinção entre falha de gate e falha de infraestrutura.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../../scripts/render-deploy.sh', import.meta.url).pathname;
const DIGEST_VALIDO = `ghcr.io/dono/app@sha256:${'a'.repeat(64)}`;

interface Cenario {
  /** Estados devolvidos em sequência pelas consultas de deploy. */
  readonly estados: string[];
  /** Rotas que devem falhar, para simular indisponibilidade. */
  readonly falhar?: 'patch' | 'post' | 'get';
  /** Resposta do POST sem id, para simular contrato quebrado. */
  readonly postSemId?: boolean;
}

let servidor: Server;
let base: string;
let chamadas: string[];

async function subirApiSimulada(cenario: Cenario): Promise<void> {
  let consulta = 0;
  chamadas = [];

  servidor = createServer((requisicao, resposta) => {
    const rota = `${requisicao.method ?? ''} ${requisicao.url ?? ''}`;
    chamadas.push(rota);

    const responder = (status: number, corpo: unknown): void => {
      resposta.writeHead(status, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify(corpo));
    };

    if (requisicao.method === 'PATCH') {
      if (cenario.falhar === 'patch') {
        responder(500, { erro: 'indisponivel' });
        return;
      }
      responder(200, { id: 'srv-1' });
      return;
    }
    if (requisicao.method === 'POST') {
      if (cenario.falhar === 'post') {
        responder(500, { erro: 'indisponivel' });
        return;
      }
      responder(201, cenario.postSemId === true ? { ok: true } : { id: 'dpl-abc' });
      return;
    }
    if (cenario.falhar === 'get') {
      responder(500, { erro: 'indisponivel' });
      return;
    }

    const estado = cenario.estados[Math.min(consulta, cenario.estados.length - 1)];
    consulta += 1;
    responder(200, { id: 'dpl-abc', status: estado });
  });

  await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const endereco = servidor.address();
  const porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;
  base = `http://127.0.0.1:${String(porta)}`;
}

async function rodar(
  imagem: string,
  ambiente: Record<string, string> = {},
): Promise<{ codigo: number; saida: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [imagem], {
      env: {
        PATH: process.env['PATH'] ?? '',
        RENDER_API_URL: base,
        RENDER_API_KEY: 'chave-de-teste',
        RENDER_SERVICE_ID: 'srv-1',
        INTERVALO_POLL_S: '0',
        ...ambiente,
      },
    });
    return { codigo: 0, saida: `${stdout}${stderr}` };
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string };
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

afterEach(async () => {
  await new Promise<void>((resolver) =>
    servidor.close(() => {
      resolver();
    }),
  );
});

describe('promoção bem-sucedida', () => {
  beforeEach(async () => {
    await subirApiSimulada({ estados: ['live'] });
  });

  it('sai 0 quando o deploy fica live', async () => {
    const resultado = await rodar(DIGEST_VALIDO);

    expect(resultado.codigo).toBe(0);
    expect(resultado.saida).toContain('live');
  });

  it('aponta a imagem antes de disparar o deploy', async () => {
    await rodar(DIGEST_VALIDO);

    const patch = chamadas.findIndex((c) => c.startsWith('PATCH'));
    const post = chamadas.findIndex((c) => c.startsWith('POST'));
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(patch);
  });

  it('reporta o id do deploy, para acompanhamento e rollback', async () => {
    const resultado = await rodar(DIGEST_VALIDO);

    expect(resultado.saida).toContain('dpl-abc');
  });
});

describe('espera por estado terminal', () => {
  it('não conclui enquanto o deploy está em andamento', async () => {
    await subirApiSimulada({ estados: ['build_in_progress', 'update_in_progress', 'live'] });

    const resultado = await rodar(DIGEST_VALIDO);

    // Seguir para o smoke com deploy em andamento testaria a versão ANTERIOR e a
    // aprovaria — falso verde exatamente quando a verificação mais importa.
    expect(resultado.codigo).toBe(0);
    expect(chamadas.filter((c) => c.startsWith('GET')).length).toBeGreaterThanOrEqual(3);
  });

  it.each(['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'])(
    'sai 1 quando o deploy termina em %s',
    async (estado) => {
      await subirApiSimulada({ estados: [estado] });

      const resultado = await rodar(DIGEST_VALIDO);

      expect(resultado.codigo).toBe(1);
      expect(resultado.saida).toContain(estado);
    },
  );

  it('sai 1 quando estoura o timeout sem estado terminal', async () => {
    await subirApiSimulada({ estados: ['update_in_progress'] });

    const resultado = await rodar(DIGEST_VALIDO, { TIMEOUT_DEPLOY_S: '0' });

    expect(resultado.codigo).toBe(1);
  });
});

describe('validação de entrada — nada é tocado', () => {
  beforeEach(async () => {
    await subirApiSimulada({ estados: ['live'] });
  });

  it('sai 2 sem imagem', async () => {
    const resultado = await rodar('');

    expect(resultado.codigo).toBe(2);
    expect(chamadas).toEqual([]);
  });

  it('sai 2 quando a imagem vem por tag em vez de digest', async () => {
    const resultado = await rodar('ghcr.io/dono/app:latest');

    expect(resultado.codigo).toBe(2);
    expect(chamadas).toEqual([]);
  });

  it('sai 2 com digest de tamanho errado', async () => {
    const resultado = await rodar(`ghcr.io/dono/app@sha256:${'a'.repeat(63)}`);

    expect(resultado.codigo).toBe(2);
    expect(chamadas).toEqual([]);
  });

  it('sai 2 sem RENDER_SERVICE_ID', async () => {
    const resultado = await rodar(DIGEST_VALIDO, { RENDER_SERVICE_ID: '' });

    expect(resultado.codigo).toBe(2);
    expect(chamadas).toEqual([]);
  });
});

describe('falha de infraestrutura é distinta de falha de gate', () => {
  it.each(['patch', 'post', 'get'] as const)('sai 3 quando a API falha em %s', async (rota) => {
    await subirApiSimulada({ estados: ['live'], falhar: rota });

    const resultado = await rodar(DIGEST_VALIDO);

    // Código 3 e não 1: nada mudou de estado, então disparar rollback trocaria um
    // problema transitório por uma mudança de estado desnecessária.
    expect(resultado.codigo).toBe(3);
  });

  it('sai 3 quando a API não devolve id de deploy', async () => {
    await subirApiSimulada({ estados: ['live'], postSemId: true });

    const resultado = await rodar(DIGEST_VALIDO);

    expect(resultado.codigo).toBe(3);
  });
});
