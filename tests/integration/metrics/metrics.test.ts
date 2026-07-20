/**
 * Cobre GET /metrics de ponta a ponta pelo app real: formato, isenção das sondas e a
 * guarda de cardinalidade — que é o que separa um endpoint de métricas de um vetor para
 * derrubar o Prometheus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { construirApp, registrarMetricasDeRequisicao } from '../../../src/app.js';
import { carregarEnv } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { esquemaTelemetria } from '../../../src/config/env.js';

/** Env mínima — os bancos apontam para porta morta porque nada aqui os consulta. */
function env(sobrescritas: Record<string, string> = {}): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
    MONGODB_URL: 'mongodb://127.0.0.1:1',
    GIT_COMMIT: 'e54a0fd',
    ...sobrescritas,
  });
}

let app: FastifyInstance;
let telemetria: Telemetria;
let comRotaParametrizada: FastifyInstance;

beforeAll(async () => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({ GIT_COMMIT: 'e54a0fd' }));
  app = await construirApp(env(), { telemetria });

  // App auxiliar com rota parametrizada: o `construirApp` já entrega a instância pronta
  // (`ready`), e a SPEC 002 — dona da primeira rota com parâmetro real — ainda não
  // existe. O que este teste guarda é o hook, que é o mesmo dos dois lados.
  comRotaParametrizada = Fastify({ logger: false });
  registrarMetricasDeRequisicao(comRotaParametrizada, 'e54a0fd');
  comRotaParametrizada.get('/usuarios/:id', () => ({ ok: true }));
  comRotaParametrizada.setNotFoundHandler((_requisicao, resposta) => {
    void resposta.status(404).send({ erro: 'nao encontrado' });
  });
  await comRotaParametrizada.ready();
});

afterAll(async () => {
  await app.close();
  await comRotaParametrizada.close();
  await telemetria.encerrar();
});

async function raspar(): Promise<string> {
  const resposta = await app.inject({ method: 'GET', url: '/metrics' });
  return resposta.body;
}

/** Linhas de série cujo nome começa pelo prefixo — descarta HELP/TYPE/UNIT. */
function series(texto: string, prefixo: string): string[] {
  return texto.split('\n').filter((linha) => linha.startsWith(prefixo));
}

describe('GET /metrics', () => {
  it('responde 200 no formato de exposição do Prometheus', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/metrics' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.headers['content-type']).toContain('text/plain');
    expect(resposta.headers['content-type']).toContain('version=0.0.4');
    expect(resposta.body).toContain('# TYPE iam_build_info gauge');
  });

  it('publica iam_build_info com version, commit e node_version', async () => {
    const [linha] = series(await raspar(), 'iam_build_info');

    expect(linha).toContain('commit="e54a0fd"');
    expect(linha).toContain(`node_version="${process.version}"`);
  });
});

describe('rótulo de rota', () => {
  it('usa o template registrado, não o valor recebido', async () => {
    await comRotaParametrizada.inject({ method: 'GET', url: '/usuarios/42' });

    const texto = await raspar();

    expect(texto).toContain('route="/usuarios/:id"');
    expect(texto).not.toContain('route="/usuarios/42"');
  });

  it('mil ids distintos não criam mil séries', async () => {
    const antes = series(await raspar(), 'iam_http_requests_total').length;

    for (let id = 0; id < 1_000; id += 1) {
      await comRotaParametrizada.inject({ method: 'GET', url: `/usuarios/${String(id)}` });
    }

    const depois = series(await raspar(), 'iam_http_requests_total');

    expect(depois).toHaveLength(antes);
    expect(depois.join('\n')).not.toMatch(/route="\/usuarios\/\d+"/);
  });

  it('caminho não roteado vira literal fixo, nunca a URL recebida', async () => {
    await comRotaParametrizada.inject({ method: 'GET', url: '/rota/que/nao/existe/segredo' });

    const texto = await raspar();

    expect(texto).toContain('route="desconhecida"');
    expect(texto).not.toContain('segredo');
  });
});

describe('rotas isentas', () => {
  it('cem sondas de health não criam série no histograma de requisição', async () => {
    for (let batida = 0; batida < 100; batida += 1) {
      await app.inject({ method: 'GET', url: '/health/live' });
      await app.inject({ method: 'GET', url: '/health/ready' });
    }

    const texto = await raspar();

    expect(texto).not.toContain('route="/health/live"');
    expect(texto).not.toContain('route="/health/ready"');
  });

  it('/metrics não aparece nas próprias métricas de requisição', async () => {
    await raspar();
    await raspar();

    expect(await raspar()).not.toContain('route="/metrics"');
  });
});

describe('METRICS_ENABLED=false', () => {
  it('não registra a rota — 404 em problem+json', async () => {
    const desligada = iniciarTelemetria(esquemaTelemetria.parse({ METRICS_ENABLED: 'false' }));
    const semMetricas = await construirApp(env({ METRICS_ENABLED: 'false' }), {
      telemetria: desligada,
    });

    try {
      const resposta = await semMetricas.inject({ method: 'GET', url: '/metrics' });

      expect(resposta.statusCode).toBe(404);
      expect(resposta.headers['content-type']).toContain('application/problem+json');
    } finally {
      await semMetricas.close();
      await desligada.encerrar();
    }
  });
});
