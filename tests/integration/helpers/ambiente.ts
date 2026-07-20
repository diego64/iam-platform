/**
 * Monta a configuração dos testes de integração a partir do ambiente disponível.
 *
 * Dois cenários, e o helper não pode impor topologia a nenhum deles:
 *
 * - CI: o runner sobe PostgreSQL e MongoDB como service containers e entrega
 *   POSTGRES_URL e MONGODB_URL prontas, nas portas padrão.
 * - Desenvolvimento: `pnpm infra:test:up` sobe o compose efêmero nas portas altas
 *   55432/57017, e as credenciais vêm das variáveis *_TEST de infra/compose/.env.
 *
 * A URL pronta ganha precedência; a composição a partir das *_TEST é o fallback.
 * Nenhuma credencial literal versionada em qualquer um dos caminhos.
 */
import { carregarEnv, type Env } from '../../../src/config/env.js';

const PORTA_POSTGRES_COMPOSE = 55_432;
const PORTA_MONGO_COMPOSE = 57_017;

function opcional(nome: string): string | undefined {
  const valor = process.env[nome];
  return valor === undefined || valor === '' ? undefined : valor;
}

function obrigatoria(nome: string): string {
  const valor = opcional(nome);
  if (valor === undefined) {
    throw new Error(
      `${nome} não definida. Em desenvolvimento, rode "pnpm infra:test:up" e garanta ` +
        'infra/compose/.env. Em CI, defina POSTGRES_URL e MONGODB_URL diretamente.',
    );
  }
  return valor;
}

/** URL do PostgreSQL de teste: a do ambiente, ou composta para o compose local. */
export function urlPostgresDeTeste(): string {
  const pronta = opcional('POSTGRES_URL');
  if (pronta !== undefined) return pronta;

  const usuario = encodeURIComponent(obrigatoria('POSTGRES_USER_TEST'));
  const senha = encodeURIComponent(obrigatoria('POSTGRES_PASSWORD_TEST'));
  const banco = obrigatoria('POSTGRES_DB_TEST');
  return `postgres://${usuario}:${senha}@127.0.0.1:${String(PORTA_POSTGRES_COMPOSE)}/${banco}`;
}

/** URL do MongoDB de teste: a do ambiente, ou composta para o compose local. */
export function urlMongoDeTeste(): string {
  const pronta = opcional('MONGODB_URL');
  if (pronta !== undefined) return pronta;

  const usuario = encodeURIComponent(obrigatoria('MONGO_INITDB_ROOT_USERNAME_TEST'));
  const senha = encodeURIComponent(obrigatoria('MONGO_INITDB_ROOT_PASSWORD_TEST'));
  return `mongodb://${usuario}:${senha}@127.0.0.1:${String(PORTA_MONGO_COMPOSE)}/?authSource=admin`;
}

/** Configuração completa apontando para a infra de teste do ambiente atual. */
export function envDeIntegracao(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    POSTGRES_URL: urlPostgresDeTeste(),
    MONGODB_URL: urlMongoDeTeste(),
    MONGODB_DB: opcional('MONGODB_DB') ?? 'iam_sessions_test',
    ...sobrescritas,
  });
}
