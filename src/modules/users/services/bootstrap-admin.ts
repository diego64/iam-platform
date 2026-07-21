/**
 * Responsabilidade: garantir o primeiro administrador na subida do processo.
 *
 * Toda rota de `/users` é admin-only, então o primeiro admin não pode nascer por HTTP —
 * seria o chicken-and-egg. Este passo lê o par de env de bootstrap e cria o usuário uma
 * única vez. A atribuição do papel `admin` fica com o bootstrap de RBAC (003); aqui só
 * nasce a linha em `users`.
 *
 * Idempotente por `ON CONFLICT (email) DO NOTHING`: subir de novo não duplica nada. Sem as
 * env, é no-op — produção com admins já criados não precisa delas. A senha é hasheada pela
 * 009 antes do INSERT e nunca é logada.
 */
import type { Pool } from 'pg';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { Logger } from '../../../shared/logger/index.js';

export interface OpcoesDeBootstrap {
  readonly email?: string;
  readonly senha?: string;
}

export async function garantirAdminDeBootstrap(deps: {
  pool: Pool;
  servicoDeSenha: ServicoDeSenha;
  opcoes: OpcoesDeBootstrap;
  logger: Logger;
}): Promise<void> {
  const { pool, servicoDeSenha, opcoes, logger } = deps;

  // Sem o par completo, não há admin de bootstrap a garantir.
  if (opcoes.email === undefined || opcoes.senha === undefined) return;

  const hash = await servicoDeSenha.gerarHash(opcoes.senha);
  const { rowCount } = await pool.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (email) DO NOTHING`,
    [opcoes.email, hash],
  );

  if ((rowCount ?? 0) > 0) {
    logger.info({ email: opcoes.email }, 'bootstrap.admin_criado');
  } else {
    logger.info({ email: opcoes.email }, 'bootstrap.admin_ja_existia');
  }
}
