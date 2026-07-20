/**
 * Responsabilidade: carregar e validar as variáveis de ambiente com Zod no boot.
 * Consumido por: todos os módulos via `import { env }`.
 * Regras:
 *  - ÚNICO arquivo do repositório autorizado a ler `process.env` (regra de lint).
 *  - Falha de validação lança ErroDeConfiguracao com TODOS os problemas de uma vez;
 *    quem trata e derruba o processo é o server.ts (T04).
 *  - Jamais expor o valor recebido de uma variável — só o nome e o motivo.
 *
 * Escopo: apenas o contrato da SPEC 021. Chaves de JWT, scrypt, rate limit e OTel
 * entram por composição nas SPECs que as consomem (007, 009, 016, 015) — ver design.md §4.
 */
import { z } from 'zod';
import type { Logger } from '../shared/logger/index.js';

export const esquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  POSTGRES_URL: z.string().url().startsWith('postgres'),
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

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
});
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
 * Valida a fonte informada e devolve a configuração congelada.
 * Recebe a fonte por parâmetro para ser testável sem mexer no process.env global.
 * @throws {ErroDeConfiguracao} quando qualquer variável está ausente ou malformada.
 */
export function carregarEnv(fonte: NodeJS.ProcessEnv = process.env): Env {
  const resultado = esquemaEnv.safeParse(fonte);

  if (!resultado.success) {
    throw new ErroDeConfiguracao(traduzirProblemas(resultado.error));
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
