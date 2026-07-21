/**
 * Cobre a instrumentação automática de ponta a ponta: uma requisição que consulta
 * PostgreSQL e MongoDB precisa produzir spans encadeados sob o mesmo trace, e o log
 * emitido dentro dela precisa carregar esse `trace_id`.
 *
 * O coletor aqui é um servidor HTTP local que guarda o que o exportador OTLP enviou. Ele
 * substitui o Collector de propósito: o que este teste precisa provar é que a
 * instrumentação envolveu `fastify`, `pg` e `mongodb` e que o pipeline exporta — não que
 * o Tempo está no ar, o que a suíte e2e cobre separadamente.
 *
 * ATENÇÃO ao topo do arquivo: `fastify`, `pg` e `mongodb` entram por `await import`
 * DEPOIS do `iniciarTelemetria`. Import estático é içado para antes de qualquer código,
 * e a instrumentação, que funciona substituindo métodos desses módulos, não teria o que
 * substituir. O sintoma não é erro: é span nenhum. Este teste já falhou exatamente assim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { MongoClient } from 'mongodb';
import { esquemaTelemetria } from '../../../src/config/env.js';
import { iniciarTelemetria, type Telemetria } from '../../../src/telemetry/sdk.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { urlMongoDeTeste, urlPostgresDeTeste } from '../helpers/ambiente.js';

interface SpanExportado {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes?: readonly { key: string; value: Record<string, unknown> }[];
}

const spansRecebidos: SpanExportado[] = [];
const linhasDeLog: Record<string, unknown>[] = [];

let coletor: Server;
let telemetria: Telemetria;
// Tipados como possivelmente ausentes porque o afterAll roda mesmo se o beforeAll falhar
// no meio — e um await em recurso não criado esconderia o erro verdadeiro atrás de um
// TypeError sem relação com a causa.
let app: FastifyInstance | undefined;
let pool: Pool | undefined;
let mongo: MongoClient | undefined;

/** Coletor de mentira: aceita o POST do OTLP e guarda os spans do corpo JSON. */
function subirColetor(): Promise<Server> {
  return new Promise((resolver) => {
    const servidor = createServer((requisicao, resposta) => {
      let corpo = '';
      requisicao.on('data', (pedaco: Buffer) => {
        corpo += pedaco.toString();
      });
      requisicao.on('end', () => {
        try {
          const carga = JSON.parse(corpo) as {
            resourceSpans?: { scopeSpans?: { spans?: SpanExportado[] }[] }[];
          };
          for (const recurso of carga.resourceSpans ?? []) {
            for (const escopo of recurso.scopeSpans ?? []) {
              spansRecebidos.push(...(escopo.spans ?? []));
            }
          }
        } catch {
          // Corpo ilegível não é o objeto deste teste — o que importa é o que chegou.
        }
        resposta.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    servidor.listen(0, '127.0.0.1', () => {
      resolver(servidor);
    });
  });
}

beforeAll(async () => {
  coletor = await subirColetor();
  const portaDoColetor = (coletor.address() as AddressInfo).port;

  telemetria = iniciarTelemetria(
    esquemaTelemetria.parse({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(portaDoColetor)}`,
      // Amostragem total: com 0.1, o teste dependeria do sorteio do trace id.
      OTEL_TRACES_SAMPLER_ARG: '1',
    }),
  );

  // Só agora — depois do SDK de pé — os módulos instrumentados são carregados.
  const { default: Fastify } = await import('fastify');
  const { Pool: PoolPg } = await import('pg');
  const { MongoClient: ClienteMongo } = await import('mongodb');

  const poolDeTeste = new PoolPg({ connectionString: urlPostgresDeTeste(), max: 2 });
  const clienteDeTeste = new ClienteMongo(urlMongoDeTeste());
  pool = poolDeTeste;
  mongo = clienteDeTeste;
  await clienteDeTeste.connect();

  const destino = new Writable({
    write(pedaco: Buffer, _codificacao, prosseguir): void {
      linhasDeLog.push(JSON.parse(pedaco.toString()) as Record<string, unknown>);
      prosseguir();
    },
  });
  const logger = criarLogger({ nivel: 'info', destino });

  app = Fastify({ logger: false });
  app.get('/consulta', async () => {
    await poolDeTeste.query('SELECT 1');
    await clienteDeTeste.db('iam_sessions_test').collection('telemetria').findOne({});
    logger.info('consulta.concluida');
    return { ok: true };
  });
  app.get('/health/live', () => ({ status: 'ok' }));
  await app.listen({ host: '127.0.0.1', port: 0 });

  const portaDoApp = (app.server.address() as AddressInfo).port;
  await fetch(`http://127.0.0.1:${String(portaDoApp)}/consulta`);
  await fetch(`http://127.0.0.1:${String(portaDoApp)}/health/live`);

  // O BatchSpanProcessor exporta em lote, fora do caminho da requisição; o flush do
  // encerramento é o que garante que tudo chegou antes das asserções.
  await telemetria.encerrar();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await mongo?.close();
  await new Promise<void>((resolver) => {
    coletor.close(() => {
      resolver();
    });
  });
});

/** Valor de um atributo de span, achatado do formato do OTLP. */
function atributo(span: SpanExportado, chave: string): string | undefined {
  const achado = span.attributes?.find((par) => par.key === chave);
  return achado === undefined ? undefined : String(Object.values(achado.value)[0]);
}

describe('instrumentação automática', () => {
  it('a requisição gera spans exportados', () => {
    expect(spansRecebidos.length).toBeGreaterThan(0);
  });

  it('a consulta ao PostgreSQL vira span filho da requisição', () => {
    const postgres = spansRecebidos.find((span) => atributo(span, 'db.system') === 'postgresql');

    expect(postgres).toBeDefined();
    expect(postgres?.parentSpanId).toBeTruthy();
  });

  it('a consulta ao MongoDB também vira span', () => {
    const mongodb = spansRecebidos.find((span) => atributo(span, 'db.system') === 'mongodb');

    expect(mongodb).toBeDefined();
    expect(mongodb?.parentSpanId).toBeTruthy();
  });

  it('os spans de banco compartilham o trace da requisição HTTP', () => {
    const daConsulta = spansRecebidos.filter(
      (span) =>
        atributo(span, 'db.system') !== undefined || atributo(span, 'http.route') !== undefined,
    );
    const traces = new Set(daConsulta.map((span) => span.traceId));

    // Um trace só: sem a instrumentação envolvendo os drivers, cada consulta viraria um
    // trace órfão — ou span nenhum.
    expect(traces.size).toBe(1);
  });

  it('nenhum atributo de span carrega string de conexão', () => {
    const tudo = JSON.stringify(spansRecebidos);

    expect(tudo).not.toMatch(/(postgres|postgresql|mongodb)(\+srv)?:\/\//);
  });
});

describe('log dentro da requisição', () => {
  it('carrega o trace_id do span ativo', () => {
    const linha = linhasDeLog.find((entrada) => entrada.msg === 'consulta.concluida');
    const daConsulta = spansRecebidos.find((span) => atributo(span, 'db.system') !== undefined);

    expect(linha?.trace_id).toBe(daConsulta?.traceId);
  });
});

describe('rotas de sonda', () => {
  it('não aparecem entre os spans exportados', () => {
    const sondas = spansRecebidos.filter((span) => {
      const rota = atributo(span, 'http.route') ?? atributo(span, 'http.target') ?? '';
      return rota.startsWith('/health') || rota === '/metrics';
    });

    expect(sondas).toEqual([]);
  });
});
