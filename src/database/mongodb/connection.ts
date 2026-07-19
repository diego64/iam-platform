/**
 * Responsabilidade: criar MongoClient e expor o Db de sessões.
 * Regras: índices são responsabilidade de indexes.ts (idempotente, rodado no boot e na migração).
 */
import { MongoClient, type Db } from 'mongodb';
import { env } from '../../config/env.js';

export async function conectarMongo(): Promise<{ cliente: MongoClient; banco: Db }> {
  const cliente = new MongoClient(env.MONGODB_URL);
  await cliente.connect();
  return { cliente, banco: cliente.db(env.MONGODB_DB) };
}
