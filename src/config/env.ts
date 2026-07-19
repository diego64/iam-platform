/**
 * Responsabilidade: carregar e validar TODAS as variáveis de ambiente com Zod no boot.
 * Consumido por: todos os módulos via import { env }.
 * Regras: falha de validação derruba o processo com mensagem clara; nunca logar valores de secrets.
 */
import { z } from 'zod';

const esquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  POSTGRES_URL: z.string().url(),
  POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),

  MONGODB_URL: z.string().min(1),
  MONGODB_DB: z.string().min(1),

  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  JWT_ACTIVE_KID: z.string().min(1),
  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  SCRYPT_COST: z.coerce.number().int().positive().default(32_768),
  SCRYPT_BLOCK_SIZE: z.coerce.number().int().positive().default(8),
  SCRYPT_PARALLELIZATION: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('iam-platform'),
  METRICS_ENABLED: z.coerce.boolean().default(true),
});

// Valida no carregamento do módulo — fail fast
export const env = esquemaEnv.parse(process.env);
export type Env = typeof env;
