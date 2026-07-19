/**
 * Responsabilidade: criar o MongoClient e expor o Db de sessões, provando a conexão no boot.
 * Regras: recebe `env` por parâmetro — nunca importa singleton de configuração (ADR-0001).
 *         Índices são responsabilidade de indexes.ts (idempotente, rodado no boot).
 */
import { MongoClient, type Db } from 'mongodb';
import type { Env } from '../../config/env.js';

/** Mesmo teto do PostgreSQL: host errado precisa falhar o boot, não pendurar. */
export const TIMEOUT_DE_CONEXAO_MS = 5_000;

export interface ConexaoMongo {
  readonly cliente: MongoClient;
  readonly banco: Db;
}

/**
 * Conecta e devolve cliente + banco. O `connect()` já valida o alcance do servidor
 * dentro de serverSelectionTimeoutMS.
 * @throws propaga o erro do driver — o server.ts converte em log fatal + exit 1.
 */
export async function conectarMongo(env: Env): Promise<ConexaoMongo> {
  const cliente = new MongoClient(env.MONGODB_URL, {
    serverSelectionTimeoutMS: TIMEOUT_DE_CONEXAO_MS,
    connectTimeoutMS: TIMEOUT_DE_CONEXAO_MS,
  });

  await cliente.connect();
  await cliente.db(env.MONGODB_DB).command({ ping: 1 });

  return { cliente, banco: cliente.db(env.MONGODB_DB) };
}
