/**
 * Responsabilidade: carregar e validar as variáveis de ambiente com Zod no boot.
 * Consumido por: todos os módulos via `import { env }`.
 * Regras:
 *  - ÚNICO arquivo do repositório autorizado a ler `process.env` (regra de lint).
 *  - Falha de validação lança ErroDeConfiguracao com TODOS os problemas de uma vez;
 *    quem trata e derruba o processo é o server.ts (T04).
 *  - Jamais expor o valor recebido de uma variável — só o nome e o motivo.
 *
 * Escopo: contrato das SPECs 021 e 015. Chaves de JWT, scrypt e rate limit entram por
 * composição nas SPECs que as consomem (007, 009, 016) — ver design.md §4.
 */
import { z } from 'zod';
import type { Logger } from '../shared/logger/index.js';

/**
 * Booleano vindo de variável de ambiente.
 *
 * `z.coerce.boolean()` não serve aqui: ele aplica `Boolean(valor)`, e `Boolean('false')`
 * é `true` — qualquer string não vazia liga a flag. Com `METRICS_ENABLED=false` no
 * ambiente, as métricas subiriam do mesmo jeito e ninguém notaria, porque o efeito de
 * "desligar" é ausência de dado, não erro.
 *
 * Aqui a lista de valores falsos é explícita e o resto do universo é verdadeiro.
 */
function booleanoDeAmbiente(padrao: boolean): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean> {
  const falsos = new Set(['false', '0', 'no', 'off', '']);
  return z
    .string()
    .optional()
    .transform((valor) => (valor === undefined ? padrao : !falsos.has(valor.trim().toLowerCase())));
}

/**
 * Contrato de telemetria, isolado porque é lido duas vezes: no schema geral,
 * junto do resto da configuração, e no módulo de telemetria — que roda antes do
 * `carregarEnv()` e não pode depender das variáveis obrigatórias de banco já existirem.
 */
const formaTelemetria = {
  METRICS_ENABLED: booleanoDeAmbiente(true),
  /** Libera `/metrics` fora de rede interna. Default fechado: abrir é decisão explícita. */
  METRICS_PUBLIC: booleanoDeAmbiente(false),
  OTEL_SERVICE_NAME: z.string().min(1).default('iam-platform'),
  /** Ausente desliga o pipeline de traces — não é erro, é a configuração de quem não coleta. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
  /**
   * Commit da imagem em execução, rótulo de `iam_build_info`. Injetado pelo CD como
   * build arg; fora dele não existe commit confiável, e mentir um valor seria pior que
   * assumir "desconhecido" durante uma investigação.
   */
  GIT_COMMIT: z.string().min(1).default('desconhecido'),
};

/**
 * `NODE_ENV` entra aqui de novo — não por duplicação, mas porque o SDK precisa dele para
 * o atributo `deployment.environment` e roda antes de o schema geral ser validado.
 */
export const esquemaTelemetria = z.object({
  ...formaTelemetria,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ConfigDeTelemetria = Readonly<z.infer<typeof esquemaTelemetria>>;

export const esquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  POSTGRES_URL: z.string().url().startsWith('postgres'),
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Certificado da autoridade (PEM) para verificar o TLS do Postgres gerenciado, quando o
  // certificado do provedor não está no bundle de CAs do sistema. Ausente, a verificação
  // usa as CAs do sistema — nunca é desligada.
  POSTGRES_CA_CERT: z.string().min(1).optional(),

  MONGODB_URL: z.string().url().startsWith('mongodb'),
  MONGODB_DB: z.string().min(1).default('iam_sessions'),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // Janela do cache de prontidão. A sonda bate a cada poucos segundos e, sem cache,
  // cada batida vira uma consulta em cada banco — multiplicado pelo número de réplicas.
  // 0 desliga, útil em teste.
  HEALTH_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(2_000),

  // Teto por dependência na checagem de prontidão. O máximo é 5s de propósito: acima
  // disso a checagem demora mais que o timeout típico da sonda, e o orquestrador mata a
  // requisição concluindo "fora" sem saber por quê — pior que um 503 dizendo qual caiu.
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(5_000).default(1_000),

  // Parâmetros do scrypt para hash de senha. O custo é o N do scrypt e precisa ser potência de 2
  // — o refinement rejeita valores intermediários, que o scrypt aceitaria em silêncio com
  // custo real menor que o pretendido. Default = 2^15, o baseline do CLAUDE.md.
  SCRYPT_COST: z.coerce
    .number()
    .int()
    .min(2 ** 10)
    .max(2 ** 20)
    .refine((n) => (n & (n - 1)) === 0, { message: 'deve ser potência de 2' })
    .default(2 ** 15),
  SCRYPT_BLOCK_SIZE: z.coerce.number().int().min(1).max(32).default(8),
  SCRYPT_PARALLELIZATION: z.coerce.number().int().min(1).max(16).default(1),

  // Segredo que decifra a chave privada de assinatura em repouso. Opcional no schema: uma
  // instância sem chave ainda gerada sobe sem ele; havendo chave active, o serviço de chaves
  // exige o segredo no boot e aborta se faltar. Como toda variável sensível, só o nome e o
  // motivo são logados — nunca o valor.
  MASTER_KEY: z.string().min(32).optional(),

  // Janela de graça em que uma chave aposentada ainda verifica tokens emitidos antes da
  // rotação. Default 15 min = TTL do access token: nenhum token válido fica órfão de chave.
  JWKS_GRACE_PERIOD_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .default(15 * 60 * 1000),

  // TTL de segurança do cache do conjunto de chaves. Cobre réplicas sem event bus: é o teto
  // de defasagem até uma chave nova aparecer em todas as instâncias.
  JWKS_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1000)
    .default(5 * 60 * 1000),

  // Tempo mínimo que a chave pré-publicada precisa ficar visível no JWKS antes de poder
  // assinar. Default 10 min = o teto de defasagem do cache interno das réplicas (5 min)
  // somado ao `max-age` que o endpoint JWKS manda para o cache dos consumidores (5 min).
  // Promover antes disso faria consumidores rejeitarem tokens de um `kid` que ainda não
  // conhecem — exatamente o downtime que a rotação em duas fases existe para evitar.
  JWKS_PREPUBLISH_MIN_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .default(10 * 60 * 1000),

  // Idade a partir da qual a chave ativa é rotacionada sozinha.
  JWKS_ROTATION_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60 * 1000)
    .max(365 * 24 * 60 * 60 * 1000)
    .default(30 * 24 * 60 * 60 * 1000),

  // De quanto em quanto tempo cada réplica verifica se é hora de rotacionar. Só uma delas
  // age por ciclo — a exclusão é por advisory lock no próprio PostgreSQL.
  JWKS_ROTATION_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .default(60 * 60 * 1000),

  // Margem após o fim da verificabilidade antes de a linha ser apagada de vez. Mantém a
  // chave por muito mais tempo do que ela é útil, para que "que chave assinou este token
  // de ontem?" ainda tenha resposta durante uma investigação.
  JWKS_PURGE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(90 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),

  // Liga o agendador de rotação. Desligado, prepare/rotate continuam disponíveis pela API
  // administrativa — só não acontecem sozinhos.
  JWKS_ROTATION_ENABLED: booleanoDeAmbiente(true),

  // Emissão de token de acesso: emissor, audiência e TTL do access token (segundos).
  // O TTL casa com a janela de graça do JWKS — nenhum token válido fica sem chave.
  JWT_ISSUER: z.string().url().default('https://iam.example.com'),
  JWT_AUDIENCE: z.string().min(1).default('iam-clients'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(60 * 60)
    .default(15 * 60),

  // Refresh token opaco. Validade deslizante por token (idle), renovada a cada
  // rotação, e teto absoluto por família que a rotação nunca estende. `grace` é a janela em
  // que uma rotação concorrente legítima (duas abas / retry) não é confundida com reuso
  // (roubo) — pequena de propósito: grace 0 gera falsos positivos que derrubam o usuário.
  REFRESH_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(90 * 24 * 60 * 60 * 1000)
    .default(7 * 24 * 60 * 60 * 1000),
  REFRESH_TOKEN_ABSOLUTE_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(365 * 24 * 60 * 60 * 1000)
    .default(30 * 24 * 60 * 60 * 1000),
  REFRESH_REUSE_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(5 * 60 * 1000)
    .default(10_000),

  // Rate limit do login por IP. Teto apertado: login é alvo clássico de brute force.
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60 * 60 * 1000)
    .default(60 * 1000),

  // Admin de bootstrap (SPEC 002). Opcionais: presentes, o server cria o primeiro admin
  // na subida (idempotente); ausentes, nada acontece. A senha nunca é logada — só o nome
  // e o motivo, como toda variável sensível deste schema.
  IAM_BOOTSTRAP_ADMIN_EMAIL: z.string().email().max(254).optional(),
  IAM_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).max(128).optional(),

  ...formaTelemetria,
});

/**
 * Configuração de telemetria isolada, para uso no bootstrap do SDK.
 *
 * **Nunca lança.** Roda na primeira linha do processo, antes de existir logger ou
 * tratamento de erro; uma variável de telemetria malformada não pode impedir o serviço
 * de subir. Valor inválido cai no default — telemetria é diagnóstico, não função.
 */
export function carregarConfigDeTelemetria(
  fonte: NodeJS.ProcessEnv = process.env,
): ConfigDeTelemetria {
  const resultado = esquemaTelemetria.safeParse(fonte);
  return Object.freeze(resultado.success ? resultado.data : esquemaTelemetria.parse({}));
}
// Sem .strict(): process.env é sempre um superset legítimo (PATH, HOME, ...).
// Chave desconhecida não invalida a configuração; ela apenas é descartada.

export type Env = Readonly<z.infer<typeof esquemaEnv>>;

/** Problema encontrado em uma variável — nome e motivo, nunca o valor recebido. */
export interface ProblemaDeVariavel {
  readonly nome: string;
  readonly problema: string;
}

export class ErroDeConfiguracao extends Error {
  public readonly codigo = 'ENV_INVALIDO';
  public readonly variaveis: readonly ProblemaDeVariavel[];

  constructor(variaveis: readonly ProblemaDeVariavel[]) {
    super('Configuração inválida — processo abortado');
    this.name = 'ErroDeConfiguracao';
    this.variaveis = variaveis;
  }
}

/**
 * Descreve o problema usando APENAS o que vem do schema (tipo esperado, conjunto de
 * enum, limites). `issue.message` é deliberadamente descartada: o Zod embute o valor
 * recebido em várias delas — "Invalid enum value. Expected 'a'|'b', received 'SEGREDO'" —
 * o que transformaria o log fatal em canal de vazamento.
 */
function descreverProblema(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined'
        ? 'obrigatória e ausente'
        : `esperado ${issue.expected}`;
    case 'invalid_enum_value':
      return `valor fora do conjunto permitido (${issue.options.join(' | ')})`;
    case 'invalid_string':
      return typeof issue.validation === 'string'
        ? `formato inválido (esperado ${issue.validation})`
        : 'formato inválido';
    case 'too_small':
      return `abaixo do mínimo permitido (${String(issue.minimum)})`;
    case 'too_big':
      return `acima do máximo permitido (${String(issue.maximum)})`;
    case 'not_multiple_of':
      return 'esperado número inteiro';
    default:
      return 'valor inválido';
  }
}

/**
 * Traduz o erro do Zod para uma lista legível de problemas.
 * `issue.path` dá o nome da variável; o motivo vem de descreverProblema, que nunca
 * lê o valor recebido — é o que impede um secret malformado de vazar para o log.
 */
function traduzirProblemas(erro: z.ZodError): ProblemaDeVariavel[] {
  return erro.issues.map((issue) => ({
    nome: issue.path.join('.') || '(raiz)',
    problema: descreverProblema(issue),
  }));
}

/**
 * Checagens que envolvem mais de uma variável — o Zod valida cada uma isoladamente e não
 * enxerga relações entre elas.
 *
 * O cache do conjunto de chaves precisa expirar **antes** da janela de graça. Durante uma
 * rotação, a réplica que ainda não recarregou o cache continua assinando com a chave que
 * outra réplica acabou de aposentar; esses tokens só continuam verificáveis enquanto a
 * chave aposentada estiver na graça. Com o cache vivendo mais que a graça, a rotação passa
 * a emitir tokens natimortos — e é uma relação entre duas variáveis independentes, o tipo
 * de configuração que ninguém revisa. Daí ser gate de boot, e não comentário no
 * .env.example.
 */
export function validarCoerencia(env: Env): ProblemaDeVariavel[] {
  const problemas: ProblemaDeVariavel[] = [];

  if (env.JWKS_CACHE_TTL_MS >= env.JWKS_GRACE_PERIOD_MS) {
    problemas.push({
      nome: 'JWKS_CACHE_TTL_MS',
      problema: 'precisa ser menor que JWKS_GRACE_PERIOD_MS (rotação sem downtime)',
    });
  }

  return problemas;
}

/**
 * Valida a fonte informada e devolve a configuração congelada.
 * Recebe a fonte por parâmetro para ser testável sem mexer no process.env global.
 * @throws {ErroDeConfiguracao} quando qualquer variável está ausente, malformada ou
 *         incoerente com outra.
 */
export function carregarEnv(fonte: NodeJS.ProcessEnv = process.env): Env {
  const resultado = esquemaEnv.safeParse(fonte);

  if (!resultado.success) {
    throw new ErroDeConfiguracao(traduzirProblemas(resultado.error));
  }

  const incoerencias = validarCoerencia(resultado.data);
  if (incoerencias.length > 0) {
    throw new ErroDeConfiguracao(incoerencias);
  }

  return Object.freeze(resultado.data);
}

/**
 * Não existe singleton `env` carregado no import: validar no topo do módulo faria
 * qualquer `import` — inclusive de teste — derrubar o processo. Quem chama carregarEnv()
 * é o server.ts, uma vez, e injeta o resultado nas factories (T05/T07).
 */

/**
 * Emite o log fatal de configuração inválida.
 *
 * Só publica NOME e MOTIVO de cada variável. O valor recebido nunca é lido nem
 * impresso: uma MASTER_KEY ou POSTGRES_URL malformada não pode acabar no log da
 * plataforma, que costuma ser retido e indexado por muito mais tempo que o incidente.
 */
export function reportarErroDeConfiguracao(erro: ErroDeConfiguracao, logger: Logger): void {
  logger.fatal(
    {
      codigo: erro.codigo,
      variaveis: erro.variaveis.map((v) => ({ nome: v.nome, problema: v.problema })),
    },
    erro.message,
  );
}
