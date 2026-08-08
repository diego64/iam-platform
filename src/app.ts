/**
 * Responsabilidade: montar a instância do Fastify — provider do Zod, Swagger, plugins de
 * borda, handler global de erros e registro dos módulos.
 * Consumido por: server.ts e testes de integração (Supertest usa o app sem listen).
 * Regras: recebe a configuração e os serviços por injeção; nunca lê process.env, nunca
 *         abre socket e nunca conhece `pg` ou `mongodb`.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { montarProblema } from './shared/errors/problem-json.js';
import { contextoDeTrace } from './shared/logger/index.js';
import { registrarRotasDeHealth } from './modules/health/index.js';
import type { ServicoDeProntidao } from './modules/health/services/prontidao.service.js';
import type { Telemetria } from './telemetry/sdk.js';
import { obterInstrumentos, rotuloDeRota } from './telemetry/metricas.js';
import { rotaIsenta } from './telemetry/rotas-isentas.js';
import { registrarRotaDeMetrics } from './modules/metrics/index.js';
import { registrarRotasDeJwks } from './modules/jwks/index.js';
import type { JwksService } from './modules/jwks/index.js';
import type { ModulosDaAplicacao } from './bootstrap/composicao.js';
import type { VerificadorDeAccessToken } from './modules/auth/index.js';
import { registrarRotasDeAuth } from './modules/auth/index.js';
import { registrarRotasDeRefresh } from './modules/refresh-token/index.js';
import { registrarRotasDeSenha } from './modules/password/index.js';
import type { DependenciasDoController as DependenciasDeSenha } from './modules/password/index.js';
import { registrarRotasDeUsuario } from './modules/users/index.js';
import type { DependenciasDoController as DependenciasDeUsuarios } from './modules/users/index.js';
import { registrarRotasDeRbac } from './modules/rbac/index.js';
import { registrarRotasDeAbac } from './modules/abac/index.js';
import { registrarRotasDeClientes } from './modules/api-clients/index.js';
import { registrarRotasDeAuditoria } from './modules/audit/index.js';
import { registrarRotasDeAdmin } from './modules/admin/index.js';
import { registrarExigenciaDeGuardAdmin } from './plugins/exigir-guard-admin.js';
import { registrarContextoDeRequisicao } from './plugins/request-context.js';
import { registrarRotasDeChaves } from './modules/jwks/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

/** Uma rota efetivamente registrada nesta instância. */
export interface RotaRegistrada {
  readonly metodo: string;
  readonly caminho: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * O que esta instância serve, na ordem de registro. Alimenta o log de inventário do
     * boot e o teste de contrato que compara o servido com o documentado — as duas coisas
     * precisam da lista real, não de uma lista escrita à mão que envelhece sozinha.
     */
    readonly inventarioDeRotas: readonly RotaRegistrada[];
  }
}

/**
 * Quantos hops de proxy confiar ao derivar `request.ip` do `X-Forwarded-For`.
 *
 * `true` confiaria na cadeia inteira, e a ponta esquerda do XFF é escrita pelo cliente:
 * qualquer um forjaria o próprio IP e escaparia do rate limit por IP que a SPEC 016 vai
 * construir em cima disso. Confiando em 1 hop, vale a entrada que o próprio proxy
 * acrescentou, que o cliente não controla.
 *
 * Fora de produção não existe proxy na frente, então confiar em qualquer header é só
 * abrir spoofing sem ganho nenhum.
 *
 * ponytail: 1 hop é o desenho do Render. Se entrar CDN ou outro proxy na frente,
 * este número sobe junto — ou vira lista de faixas confiáveis.
 */
export function hopsDeProxyConfiaveis(env: Env): number | false {
  return env.NODE_ENV === 'production' ? 1 : false;
}

export interface DependenciasDoApp {
  /**
   * Serviço de prontidão. Opcional porque testes que só exercitam liveness ou o handler
   * de erro não precisam de banco — nesse caso o readiness responde 503, que é a
   * resposta honesta para uma instância sem dependências configuradas.
   */
  readonly prontidao?: ServicoDeProntidao;
  /**
   * Telemetria já iniciada. Ausente — como na maior parte dos testes — o app sobe sem
   * hook de métrica e sem rota `/metrics`: instrumentar teste unitário só acrescenta
   * ruído e lentidão.
   */
  readonly telemetria?: Telemetria;
  /**
   * Serviço de chaves. Ausente, o app sobe sem o endpoint `/.well-known/jwks.json` — os
   * testes que só exercitam outras rotas não precisam de chaves nem de banco.
   */
  readonly jwks?: JwksService;
  /**
   * Serviços de cada módulo, vindos do composition root. Ausentes, o app sobe servindo só
   * o que não depende de banco (health, metrics, jwks) — não é conveniência, é requisito:
   * dezenas de testes exercitam o handler de erro ou o 404 sem PostgreSQL por perto.
   */
  readonly modulos?: ModulosDaAplicacao;
}

/** Única rota de senha que exige token — as outras existem justamente para quem não tem. */
const ROTA_DE_TROCA_DE_SENHA = '/auth/password/change';

/**
 * Registra as rotas de senha num escopo próprio, com o access token verificado apenas na
 * troca autenticada.
 *
 * `forgot`, `reset` e `policy` são públicas por definição: quem esqueceu a senha não tem
 * token para apresentar. Um hook valendo para o escopo inteiro fecharia as três, então o
 * preHandler decide pela rota.
 *
 * ponytail: uma comparação de caminho. Vira lista quando existir a segunda rota de senha
 * autenticada.
 */
async function registrarModuloDeSenha(
  app: FastifyInstance,
  deps: DependenciasDeSenha,
  verificarAccessToken: VerificadorDeAccessToken,
): Promise<void> {
  await app.register((escopo, _opcoes, pronto) => {
    escopo.addHook('preHandler', async (requisicao, resposta) => {
      if (requisicao.routeOptions.url === ROTA_DE_TROCA_DE_SENHA) {
        await verificarAccessToken(requisicao, resposta);
      }
    });
    registrarRotasDeSenha(escopo, deps);
    pronto();
  });
}

/**
 * Registra as rotas de usuário num escopo com o access token verificado em todas elas.
 *
 * As sete são administrativas e o módulo autoriza por dentro do controller, através da
 * porta `AutorizadorAdmin` — que é síncrona e lê `requisicao.usuario`. Quem popula esse
 * campo é o verificador, e ele precisa rodar antes: sem o hook, o autorizador veria
 * requisição nenhuma autenticada e recusaria todas por falta de token.
 */
async function registrarModuloDeUsuarios(
  app: FastifyInstance,
  deps: DependenciasDeUsuarios,
  verificarAccessToken: VerificadorDeAccessToken,
): Promise<void> {
  await app.register((escopo, _opcoes, pronto) => {
    escopo.addHook('preHandler', verificarAccessToken);
    registrarRotasDeUsuario(escopo, deps);
    pronto();
  });
}

/** Prontidão degenerada: usada quando o app sobe sem dependências injetadas. */
function prontidaoIndisponivel(): ServicoDeProntidao {
  return {
    consultar: () => Promise.resolve({ pronto: false, encerrando: false, dependencias: [] }),
    marcarEncerrando: () => undefined,
  };
}

/**
 * Mede toda requisição atendida, exceto as isentas.
 *
 * `onResponse` e não `onSend`: aqui a resposta já foi escrita, então o `statusCode` é
 * definitivo e o `elapsedTime` cobre o tempo inteiro, inclusive a serialização.
 *
 * O rótulo sai de `routeOptions.url`, o template registrado — nunca de `request.url`.
 * `/users/42` precisa virar `/users/:id`; com o valor bruto, cada usuário criaria uma
 * série e o Prometheus cairia sob a própria cardinalidade.
 */
export function registrarMetricasDeRequisicao(app: FastifyInstance, commit: string): void {
  const instrumentos = obterInstrumentos(commit);

  app.addHook('onResponse', (requisicao, resposta, prosseguir) => {
    const rota = rotuloDeRota(requisicao.routeOptions.url);

    // Sonda de liveness a cada poucos segundos e raspagem a cada 15 s dominariam o
    // histograma: o p95 passaria a descrever o health check, não o serviço.
    if (!rotaIsenta(rota)) {
      instrumentos.registrarRequisicao(
        {
          method: requisicao.method,
          route: rota,
          status_code: resposta.statusCode,
        },
        resposta.elapsedTime / 1_000,
      );
    }

    prosseguir();
  });
}

export async function construirApp(
  env: Env,
  dependencias: DependenciasDoApp = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // O mesmo mixin do criarLogger: o Fastify instancia o Pino por conta própria, e sem
    // repeti-lo aqui justamente os logs de requisição — os que mais importam numa
    // investigação — seriam os únicos sem trace_id.
    logger: { level: env.LOG_LEVEL, mixin: contextoDeTrace },
    trustProxy: hopsDeProxyConfiaveis(env),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Antes de qualquer rota: o hook abre o contexto que a trilha de auditoria lê para saber
  // de onde veio a chamada. Registrado depois, as rotas já definidas não passariam por ele.
  registrarContextoDeRequisicao(app);

  // Antes das rotas, e não como teste: registrar uma rota administrativa sem quem a
  // autentique e quem a autorize passa a impedir o processo de subir.
  registrarExigenciaDeGuardAdmin(app);

  const inventarioDeRotas: RotaRegistrada[] = [];
  app.decorate('inventarioDeRotas', inventarioDeRotas);
  app.addHook('onRoute', (opcoes) => {
    const metodos = Array.isArray(opcoes.method) ? opcoes.method : [opcoes.method];
    for (const metodo of metodos) {
      // O Fastify cria um HEAD para cada GET. Ele não é superfície declarada por ninguém:
      // entraria no inventário sem nunca aparecer no OpenAPI, e o contrato acusaria uma
      // divergência que não existe.
      if (metodo !== 'HEAD') inventarioDeRotas.push({ metodo, caminho: opcoes.url });
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'iam-platform', version: '0.1.0' },
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // A UI (e o /docs/json que vem com ela) publica a superfície inteira da API sem
  // O @fastify/swagger acima continua registrado em todo ambiente: ele só constrói o
  // documento em memória, sem expor rota — é o que alimenta app.swagger() e o teste de
  // contrato.
  if (env.NODE_ENV !== 'production') {
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  /**
   * `global: false`: o teto é por rota, declarado onde a rota é definida — login merece um
   * número mais apertado que a leitura de papéis, e um limite único esconderia isso atrás
   * de uma média, ainda contando requisição de health check.
   *
   * Precisa vir ANTES de qualquer rota: uma rota que declara `config.rateLimit` sem o
   * plugin registrado **falha no registro**, e o processo não sobe.
   */
  await app.register(fastifyRateLimit, { global: false });

  await app.register(fastifyHelmet);

  // Origem fechada por default. `origin: false` não emite cabeçalho de liberação nenhum,
  // então o navegador barra qualquer página que tente chamar esta API — que é o estado
  // correto para um IdP sem front conhecido.
  await app.register(fastifyCors, {
    origin: env.CORS_ALLOWED_ORIGINS.length === 0 ? false : [...env.CORS_ALLOWED_ORIGINS],
  });

  /**
   * Handler global: toda saída de erro sai como problem+json.
   * Em erro não previsto, `detail` é fixo — stack, SQL e mensagem do driver ficam
   * apenas no log, nunca na resposta.
   */
  app.setErrorHandler((erro: FastifyError, requisicao, resposta) => {
    if (hasZodFastifySchemaValidationErrors(erro)) {
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('validation-error', 'Requisição inválida', 400));
      return;
    }

    const status = erro.statusCode ?? 500;

    if (status >= 500) {
      requisicao.log.error({ err: erro }, 'erro não tratado');
      void resposta
        .status(500)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('internal-error', 'Erro interno', 500));
      return;
    }

    void resposta
      .status(status)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('request-error', erro.message, status));
  });

  // O 404 do Fastify não passa pelo setErrorHandler — sem este handler, rota
  // inexistente escaparia do formato problem+json exigido pelo CLAUDE.md.
  app.setNotFoundHandler((_requisicao, resposta) => {
    void resposta
      .status(404)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('not-found', 'Recurso não encontrado', 404));
  });

  const exportador = dependencias.telemetria?.exportadorPrometheus;
  if (exportador !== undefined) {
    registrarMetricasDeRequisicao(app, env.GIT_COMMIT);
    registrarRotaDeMetrics(app, {
      exportador,
      restringirAoInterno: env.NODE_ENV === 'production' && !env.METRICS_PUBLIC,
    });
  }

  registrarRotasDeHealth(app, {
    prontidao: dependencias.prontidao ?? prontidaoIndisponivel(),
  });

  if (dependencias.jwks !== undefined) {
    registrarRotasDeJwks(app, { jwks: dependencias.jwks });
  }

  const modulos = dependencias.modulos;
  if (modulos !== undefined) {
    registrarRotasDeAuth(app, modulos.auth);
    registrarRotasDeRefresh(app, modulos.refresh);
    await registrarModuloDeSenha(app, modulos.senha, modulos.auth.verificarAccessToken);
    await registrarModuloDeUsuarios(app, modulos.users, modulos.auth.verificarAccessToken);
    registrarRotasDeRbac(app, modulos.rbac);
    registrarRotasDeAbac(app, modulos.abac);
    registrarRotasDeClientes(app, modulos.clientes);
    registrarRotasDeAuditoria(app, modulos.auditoria);
    registrarRotasDeAdmin(app, modulos.admin);

    // Ausente quando não há segredo mestre: sem ele o serviço de rotação não existe, e as
    // rotas administrativas de chave não teriam o que servir.
    if (modulos.chaves !== undefined) {
      registrarRotasDeChaves(app, modulos.chaves);
    }
  }

  await app.ready();
  return app;
}
