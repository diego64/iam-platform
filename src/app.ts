/**
 * Responsabilidade: montar a instância do Fastify — provider do Zod, Swagger, plugins de
 * borda, handler global de erros e registro dos módulos.
 * Consumido por: server.ts e testes de integração (Supertest usa o app sem listen).
 * Regras: recebe a configuração e os serviços por injeção; nunca lê process.env, nunca
 *         abre socket e nunca conhece `pg` ou `mongodb`.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyRateLimit from '@fastify/rate-limit';
import { criarStoreDoPlugin } from './shared/rate-limit/fastify-store.js';
import { ehExcessoDeRateLimit, problemaDeRateLimit } from './shared/rate-limit/resposta-429.js';
import type { ContadorDeRateLimit } from './shared/rate-limit/types.js';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import {
  CABECALHOS_DA_DOCUMENTACAO,
  CABECALHOS_DE_ERRO_SEM_ROTA,
  CABECALHOS_DE_SEGURANCA,
} from './shared/http/security-headers.js';
import { registrarControleDeCache } from './shared/http/cache-control.js';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { montarProblema } from './shared/errors/problem-json.js';
import { contextoDeTrace } from './shared/logger/index.js';
import { registrarRotaDeSecurityTxt, registrarRotasDeHealth } from './modules/health/index.js';
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
import { registrarRotasDeMetadados, registrarRotasDeOAuth } from './modules/oauth/index.js';
import { registrarRotasDeMfa } from './modules/mfa/index.js';
import { registrarRotasDeSeguranca } from './modules/security-events/index.js';
import { registrarRotasDeSenha } from './modules/password/index.js';
import type { DependenciasDoController as DependenciasDeSenha } from './modules/password/index.js';
import { registrarRotasDeUsuario } from './modules/users/index.js';
import type { DependenciasDoController as DependenciasDeUsuarios } from './modules/users/index.js';
import { registrarRotasDeRbac } from './modules/rbac/index.js';
import { registrarRotasDeAbac } from './modules/abac/index.js';
import { registrarRotasDeClientes } from './modules/api-clients/index.js';
import { registrarRotasDeAuditoria } from './modules/audit/index.js';
import { registrarRotasDeNotificacoes } from './modules/notifications/index.js';
import { registrarContextoDeRequisicao } from './plugins/request-context.js';
import { registrarRotasDeChaves } from './modules/jwks/index.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

/** Prefixo da documentação interativa — só existe fora de produção. */
const PREFIXO_DA_DOCUMENTACAO = '/docs';

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

/** O que o app precisa para compartilhar o contador de rate limit entre as réplicas. */
export interface RateLimitDoApp {
  readonly contador: ContadorDeRateLimit;
  readonly pepper: string;
  readonly aoFalhar?: () => void;
  /** Teto por IP estourado — a dimensão que o plugin decide sozinho. */
  readonly aoExcederPorIp?: () => void;
}

export interface DependenciasDoApp {
  /**
   * Contador de rate limit compartilhado. Ausente — como na maior parte dos testes — o
   * plugin cai no contador local dele, que é o comportamento de antes desta SPEC: correto
   * num processo só, e insuficiente com mais de uma réplica.
   */
  readonly rateLimit?: RateLimitDoApp;
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

/**
 * Traduz para problem+json os erros que o Fastify emite **antes** de haver rota: caminho
 * longo demais, versão de cabeçalho inválida, corpo malformado no parser interno.
 *
 * Esses erros não passam pelo `setErrorHandler` — saem no formato do próprio framework,
 * como `application/json`, fora do contrato da plataforma. No caso do caminho longo é pior
 * que uma inconsistência de formato: o corpo default **ecoa de volta o caminho ofensivo
 * inteiro**, devolvendo ao cliente a string que ele mesmo enviou.
 */
export function responderErroDeFramework(
  erro: FastifyError,
  requisicao: FastifyRequest,
  resposta: FastifyReply,
): void {
  const status = erro.statusCode ?? 400;

  /**
   * Sem registro a borda fica muda: requisição malformada, caminho gigante e varredura de
   * URL não deixam sinal em nível nenhum. É onde a sondagem chega primeiro, e é da ausência
   * de sinal aqui que a detecção de abuso não tem como suspeitar.
   *
   * Só o código, o status e o método — nunca `err`. A mensagem e o stack destes erros
   * **embutem a string recebida do cliente**: registrar o objeto inteiro devolveria ao log o
   * mesmo caminho ofensivo que a resposta deixou de ecoar, e o log fica retido muito mais
   * tempo que a requisição. O código já diz o que aconteceu; o valor não acrescenta nada
   * que valha carregar.
   */
  const evento = {
    evento: 'erro_de_framework',
    codigo: erro.code,
    status,
    metodo: requisicao.method,
  };

  if (status >= 500) {
    requisicao.log.error(evento, 'erro de framework antes do roteamento');
    void resposta
      .status(status)
      .headers(CABECALHOS_DE_ERRO_SEM_ROTA)
      .type(TIPO_PROBLEM_JSON)
      // O mesmo tipo que o handler global usa acima de 500: um erro de servidor rotulado
      // como erro de requisição manda o cliente procurar defeito no que ele enviou.
      .send(montarProblema('internal-error', 'Erro interno', status));
    return;
  }

  requisicao.log.warn(evento, 'requisição recusada antes do roteamento');
  void resposta
    .status(status)
    // Este caminho não passa por gancho nenhum — nem `onRequest`, onde o plugin escreve os
    // cabeçalhos, nem `onSend`, onde o controle de cache decide. Sem escrevê-los aqui, a
    // resposta a uma requisição malformada sairia sem política de segurança alguma.
    .headers(CABECALHOS_DE_ERRO_SEM_ROTA)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema('request-error', 'Requisição inválida', status));
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
    // Sem estes quatro, o processo fica nos defaults do Fastify: 1 MB de corpo, nenhum
    // timeout de requisição e 100 caracteres de parâmetro. O que falta ali é o teto de
    // requisição — um cliente abre a conexão, envia um byte por vez e segura o worker
    // enquanto quiser, sem nunca estourar limite nenhum.
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    requestTimeout: env.HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    routerOptions: { maxParamLength: env.HTTP_MAX_PARAM_LENGTH },
    frameworkErrors: responderErroDeFramework,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Antes de qualquer rota: o hook abre o contexto que a trilha de auditoria lê para saber
  // de onde veio a chamada. Registrado depois, as rotas já definidas não passariam por ele.
  registrarContextoDeRequisicao(app);

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

  /**
   * Política relaxada só para a documentação, pela configuração por rota do próprio helmet.
   *
   * O caminho óbvio — registrar a UI num escopo com um helmet próprio — não funciona: o
   * plugin é publicado com `fastify-plugin`, então um registro aninhado escapa do escopo e
   * sobrescreve a configuração global em vez de conviver com ela. A configuração por rota é
   * o mecanismo que o plugin oferece para exatamente isto, e não vaza: só as rotas que
   * casam o prefixo recebem a sobreposição.
   *
   * Precisa estar aqui, antes do registro da UI: o gancho vale para as rotas declaradas
   * depois dele.
   */
  app.addHook('onRoute', (opcoes) => {
    if (opcoes.url.startsWith(PREFIXO_DA_DOCUMENTACAO)) {
      opcoes.config = { ...opcoes.config, helmet: CABECALHOS_DA_DOCUMENTACAO };
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

  // A UI (e o `/docs/json` que vem com ela) publica a superfície inteira da API sem pedir
  // credencial — em produção isso é um mapa entregue de graça, e por isso ela não sobe lá.
  // O @fastify/swagger acima continua registrado em todo ambiente: ele só constrói o
  // documento em memória, sem expor rota — é o que alimenta app.swagger() e o teste de
  // contrato.
  if (env.NODE_ENV !== 'production') {
    await app.register(fastifySwaggerUi, { routePrefix: PREFIXO_DA_DOCUMENTACAO });
  }

  /**
   * `global: false`: o teto é por rota, declarado onde a rota é definida — login merece um
   * número mais apertado que a leitura de papéis, e um limite único esconderia isso atrás
   * de uma média, ainda contando requisição de health check.
   *
   * Precisa vir ANTES de qualquer rota: uma rota que declara `config.rateLimit` sem o
   * plugin registrado **falha no registro**, e o processo não sobe.
   */
  await app.register(fastifyRateLimit, {
    global: false,
    // Com o store compartilhado, o teto passa a valer para a plataforma inteira e não por
    // processo. Sem ele, o limite efetivo é o configurado vezes o número de réplicas.
    ...(dependencias.rateLimit === undefined
      ? {}
      : {
          store: criarStoreDoPlugin({
            contador: dependencias.rateLimit.contador,
            pepper: dependencias.rateLimit.pepper,
            aoExceder: () => {
              dependencias.rateLimit?.aoExcederPorIp?.();
            },
            aoFalhar: () => {
              dependencias.rateLimit?.aoFalhar?.();
              app.log.warn(
                { evento: 'rate_limit.contador_indisponivel' },
                'contador de rate limit indisponível: a requisição seguiu sem o limite',
              );
            },
          }),
        }),
  });

  await app.register(fastifyHelmet, CABECALHOS_DE_SEGURANCA);

  // Depois do plugin, antes das rotas: o gancho vale para toda resposta que ainda não
  // tenha decidido o próprio cache.
  registrarControleDeCache(app);

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

    // O plugin de rate limit lança um erro com `statusCode` 429; sem este ramo ele cairia
    // no genérico e sairia como `request-error`, indistinguível de qualquer outro 4xx.
    if (ehExcessoDeRateLimit(erro)) {
      void resposta.status(429).type(TIPO_PROBLEM_JSON).send(problemaDeRateLimit());
      return;
    }

    const status = erro.statusCode ?? 500;

    // O corpo grande demais é recusado pelo parser e chega aqui já com 413. Contar é o que
    // separa "o teto está protegendo" de "o teto está apertado demais e mordendo tráfego
    // legítimo" — sem a série, um teto errado aparece só como erro do lado do cliente.
    if (status === 413 && dependencias.telemetria?.exportadorPrometheus !== undefined) {
      obterInstrumentos(env.GIT_COMMIT).registrarCorpoRecusado(
        rotuloDeRota(requisicao.routeOptions.url),
      );
    }

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

  registrarRotaDeSecurityTxt(app);

  if (dependencias.jwks !== undefined) {
    registrarRotasDeJwks(app, { jwks: dependencias.jwks });
  }

  const modulos = dependencias.modulos;
  if (modulos !== undefined) {
    registrarRotasDeAuth(app, modulos.auth);
    registrarRotasDeRefresh(app, modulos.refresh);
    // O endpoint de token vive num escopo encapsulado (formulário e erro da RFC 6749); os
    // metadados ficam fora dele, porque são JSON público.
    await registrarRotasDeOAuth(app, modulos.oauth);
    registrarRotasDeMetadados(app, modulos.metadadosDeOAuth);
    await registrarModuloDeSenha(app, modulos.senha, modulos.auth.verificarAccessToken);
    await registrarModuloDeUsuarios(app, modulos.users, modulos.auth.verificarAccessToken);
    registrarRotasDeRbac(app, modulos.rbac);
    registrarRotasDeAbac(app, modulos.abac);
    registrarRotasDeClientes(app, modulos.clientes);
    registrarRotasDeAuditoria(app, modulos.auditoria);
    registrarRotasDeSeguranca(app, modulos.seguranca);
    registrarRotasDeNotificacoes(app, modulos.notificacoes);

    // Ausente quando não há segredo mestre: sem ele o serviço de rotação não existe, e as
    // rotas administrativas de chave não teriam o que servir.
    if (modulos.chaves !== undefined) {
      registrarRotasDeChaves(app, modulos.chaves);
    }

    // Mesma regra: sem segredo mestre não há como cifrar o segredo TOTP em repouso, e as
    // rotas de MFA simplesmente não existem.
    if (modulos.mfa !== undefined) {
      await registrarRotasDeMfa(app, modulos.mfa);
    }
  }

  await app.ready();
  return app;
}
