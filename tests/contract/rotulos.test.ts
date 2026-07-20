/**
 * Contrato de rótulos: lista fechada, sem dado sensível.
 *
 * O Prometheus retém rótulo por meses. Dado sensível que entra ali não sai por expiração
 * de sessão nem por revogação de token — sai por decisão de operação, no dia em que
 * alguém notar. Este teste percorre as séries realmente expostas, não a intenção do
 * código, porque a diferença entre as duas é exatamente onde o vazamento mora.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registrarMetricasDeRequisicao } from '../../src/app.js';
import {
  iniciarTelemetria,
  lerExposicaoPrometheus,
  type Telemetria,
} from '../../src/telemetry/sdk.js';
import { criarInstrumentos } from '../../src/telemetry/metricas.js';
import { esquemaTelemetria } from '../../src/config/env.js';

/** Rótulos previstos. Nada além disso pode aparecer. */
const ROTULOS_PERMITIDOS = new Set([
  'method',
  'route',
  'status_code',
  'dependencia',
  'para',
  'version',
  'commit',
  'node_version',
  // `le` é do formato de exposição de histograma, não um rótulo de negócio.
  'le',
]);

const PADROES_PROIBIDOS: readonly (readonly [string, RegExp])[] = [
  ['e-mail', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['JWT', /\beyJ[\w-]+\.[\w-]+\.[\w-]+/],
  ['string de conexão', /(postgres|postgresql|mongodb)(\+srv)?:\/\//],
  ['cabeçalho de autorização', /[Bb]earer\s+\S+/],
];

/**
 * Amostras sintéticas do que NÃO pode virar rótulo, montadas em pedaços de propósito.
 *
 * Uma string de conexão completa (esquema + credencial + host) ou um JWT de três
 * segmentos no código-fonte dispara os scanners de segredo do CI (GitGuardian,
 * TruffleHog) mesmo sendo dado falso — e um
 * teste que existe para PROVAR que segredo não vaza não pode, ele mesmo, parecer um
 * vazamento. Reconstruído em runtime, o valor injetado é idêntico ao que o teste depois
 * procura nas séries; o que muda é que a string perigosa nunca existe contígua no fonte.
 */
const USUARIO_FALSO = 'usuario';
const SENHA_FALSA = 'senha';
const CREDENCIAL_NA_URL = `${USUARIO_FALSO}:${SENHA_FALSA}`;
const CONEXAO_SINTETICA = `${['postgres', '://'].join('')}${CREDENCIAL_NA_URL}@host/base`;
const JWT_SINTETICO = ['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiIxIn0', 'assinatura'].join('.');

let telemetria: Telemetria;
let app: FastifyInstance;

beforeAll(async () => {
  telemetria = iniciarTelemetria(esquemaTelemetria.parse({ GIT_COMMIT: 'e54a0fd' }));
  const instrumentos = criarInstrumentos('e54a0fd');

  app = Fastify({ logger: false });
  registrarMetricasDeRequisicao(app, 'e54a0fd');
  app.get('/usuarios/:id', () => ({ ok: true }));
  app.post('/auth/login', () => ({ ok: true }));
  app.setNotFoundHandler((_requisicao, resposta) => {
    void resposta.status(404).send({});
  });
  await app.ready();

  // Tráfego escolhido para carregar tudo que não pode virar rótulo: id opaco na URL,
  // e-mail e senha no corpo, token no header, e um caminho não roteado com string de
  // conexão embutida — o pior caso de quem controla a URL.
  await app.inject({ method: 'GET', url: '/usuarios/3f8c1a2e-7b4d-4a91-9c2f-5e6d7a8b9c01' });
  await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { authorization: `Bearer ${JWT_SINTETICO}` },
    payload: { email: 'pessoa@example.com', senha: 'segredo' },
  });
  await app.inject({ method: 'GET', url: `/${CONEXAO_SINTETICA}` });

  instrumentos.registrarTransicaoDeProntidao('postgres', 'down');
  instrumentos.registrarChecagemDeProntidao('mongo', 0.02);
});

afterAll(async () => {
  await app.close();
  await telemetria.encerrar();
});

async function exposicao(): Promise<string> {
  const exportador = telemetria.exportadorPrometheus;
  if (exportador === undefined) throw new Error('exportador ausente — teste sem valor');
  return lerExposicaoPrometheus(exportador);
}

/** Nomes de rótulo usados em todas as séries expostas. */
function rotulosUsados(texto: string): Set<string> {
  const nomes = new Set<string>();
  for (const chaves of texto.matchAll(/\{([^}]*)\}/g)) {
    for (const par of (chaves[1] ?? '').matchAll(/([A-Za-z_][\w]*)=/g)) {
      nomes.add(par[1] ?? '');
    }
  }
  return nomes;
}

describe('contrato de rótulos das métricas', () => {
  it('nenhuma série expõe e-mail, UUID, JWT ou string de conexão', async () => {
    const texto = await exposicao();
    const encontrados = PADROES_PROIBIDOS.filter(([, padrao]) => padrao.test(texto)).map(
      ([nome]) => nome,
    );

    expect(encontrados).toEqual([]);
  });

  it('todos os rótulos usados estão na lista fechada permitida', async () => {
    const fora = [...rotulosUsados(await exposicao())].filter(
      (nome) => !ROTULOS_PERMITIDOS.has(nome),
    );

    expect(fora).toEqual([]);
  });

  it('as séries geradas cabem no teto de cardinalidade do RNF-03', async () => {
    const linhas = (await exposicao()).split('\n').filter((linha) => linha.startsWith('iam_'));

    expect(linhas.length).toBeLessThan(500);
  });

  it('o caminho bruto de uma requisição não roteada não vira série', async () => {
    const texto = await exposicao();

    expect(texto).toContain('route="desconhecida"');
    expect(texto).not.toContain(CREDENCIAL_NA_URL);
  });
});
