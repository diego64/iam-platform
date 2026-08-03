/**
 * Sobe o app de produção — `construirModulos` + `construirApp` — contra os bancos reais.
 *
 * Diferente dos helpers por módulo, aqui não há fiação própria: o que os testes exercitam é
 * exatamente o que `server.ts` monta. Só a configuração muda, e só no que o ambiente de
 * teste exige: scrypt mais barato (a suíte mede lógica, não fator de trabalho) e graça de
 * reuso zero (a detecção fica determinística, sem esperar relógio).
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import { construirApp } from '../../../src/app.js';
import { construirModulos } from '../../../src/bootstrap/composicao.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { criarServicoDeSenhaDaEnv } from '../../../src/shared/crypto/password.service.js';
import {
  criarJwksService,
  criarRepositorioJwks,
  garantirChaveDeBootstrap,
} from '../../../src/modules/jwks/index.js';
import { envDeIntegracao } from '../helpers/ambiente.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
/** Mesmo custo que `montarAppReal` injeta — o hash semeado precisa casar com o do login. */
const CUSTO_DE_TESTE = 2 ** 14;

/** Cria um usuário com hash gerado pelo mesmo serviço (e parâmetros) que o login usa. */
export async function semearUsuario(pool: Pool, email: string, senha: string): Promise<string> {
  const servico = criarServicoDeSenhaDaEnv(
    envDeIntegracao({ SCRYPT_COST: String(CUSTO_DE_TESTE) }),
  );
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, await servico.gerarHash(senha)],
  );
  return rows[0]?.id ?? '';
}

export async function montarAppReal(opcoes: {
  pool: Pool;
  banco: Db;
  sobrescritas?: NodeJS.ProcessEnv;
}): Promise<FastifyInstance> {
  const env = envDeIntegracao({
    MASTER_KEY: MASTER,
    SCRYPT_COST: String(CUSTO_DE_TESTE),
    REFRESH_REUSE_GRACE_MS: '0',
    ...opcoes.sobrescritas,
  });

  const logger = criarLogger({ nivel: 'fatal' });
  const repoJwks = criarRepositorioJwks(opcoes.pool);
  await garantirChaveDeBootstrap({ repo: repoJwks, masterKey: MASTER, logger });

  const jwks = criarJwksService({ repo: repoJwks, masterKey: MASTER, cacheTtlMs: 0 });
  await jwks.iniciar();

  const modulos = construirModulos({
    env,
    pool: opcoes.pool,
    banco: opcoes.banco,
    jwks,
    repoJwks,
    logger,
  });

  return construirApp(env, { jwks, modulos });
}
