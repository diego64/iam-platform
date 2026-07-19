/**
 * Monta a configuração apontada para os containers efêmeros de
 * infra/compose/docker-compose.test.yml (portas altas, tmpfs).
 *
 * As credenciais vêm do ambiente — infra/compose/.env em desenvolvimento (carregado
 * pelo script test:integration) ou dos secrets do runner em CI. Nada de credencial
 * literal versionada.
 */
import { carregarEnv, type Env } from '../../../src/config/env.js';

const PORTA_POSTGRES_TESTE = 55_432;
const PORTA_MONGO_TESTE = 57_017;

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') {
    throw new Error(
      `${nome} não definida. Rode "pnpm infra:test:up" e garanta infra/compose/.env, ` +
        'ou exporte as variáveis de teste no ambiente.',
    );
  }
  return valor;
}

/** URL do PostgreSQL efêmero de teste. */
export function urlPostgresDeTeste(): string {
  const usuario = encodeURIComponent(obrigatoria('POSTGRES_USER_TEST'));
  const senha = encodeURIComponent(obrigatoria('POSTGRES_PASSWORD_TEST'));
  const banco = obrigatoria('POSTGRES_DB_TEST');
  return `postgres://${usuario}:${senha}@127.0.0.1:${String(PORTA_POSTGRES_TESTE)}/${banco}`;
}

/** URL do MongoDB efêmero de teste. */
export function urlMongoDeTeste(): string {
  const usuario = encodeURIComponent(obrigatoria('MONGO_INITDB_ROOT_USERNAME_TEST'));
  const senha = encodeURIComponent(obrigatoria('MONGO_INITDB_ROOT_PASSWORD_TEST'));
  return `mongodb://${usuario}:${senha}@127.0.0.1:${String(PORTA_MONGO_TESTE)}/?authSource=admin`;
}

/** Configuração completa apontando para a infra efêmera. */
export function envDeIntegracao(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: urlPostgresDeTeste(),
    MONGODB_URL: urlMongoDeTeste(),
    MONGODB_DB: 'iam_sessions_test',
    ...sobrescritas,
  });
}
