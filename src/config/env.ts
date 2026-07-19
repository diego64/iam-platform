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
 * Traduz o erro do Zod para uma lista legível de problemas.
 * `issue.path` dá o nome da variável; `issue.message`, o motivo. O valor recebido
 * nunca é lido — é o que impede um secret malformado de vazar para o log da plataforma.
 */
function traduzirProblemas(erro: z.ZodError): ProblemaDeVariavel[] {
  return erro.issues.map((issue) => ({
    nome: issue.path.join('.') || '(raiz)',
    problema:
      issue.code === 'invalid_type' && issue.received === 'undefined'
        ? 'obrigatória e ausente'
        : issue.message,
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
