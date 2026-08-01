/**
 * Responsabilidade: popular dados de desenvolvimento/teste — roles base, um admin de dev e o
 * usuário de carga (load@iam.local) usado pelos cenários k6.
 * Regras: idempotente (ON CONFLICT DO NOTHING); aborta em NODE_ENV=production — as senhas
 *         aqui são fixas e de conhecimento público (versionadas), nunca podem tocar produção.
 */
import type { Pool } from 'pg';

import { carregarEnv } from '../src/config/env.js';
import { criarPoolPostgres } from '../src/database/postgres/connection.js';
import { criarServicoDeSenhaDaEnv } from '../src/shared/crypto/password.service.js';
import type { ServicoDeSenha } from '../src/shared/crypto/password.service.js';
import { criarLogger } from '../src/shared/logger/index.js';
import type { Logger } from '../src/shared/logger/index.js';

// Roles base. `permissions`/`role_permissions` ficam de fora: nenhuma rota checa permissão
// ainda — a autorização admin olha o nome do papel. Semear permissões seria dado morto.
// ponytail: sem permissions/role_permissions até uma rota consumi-las.
const ROLES_BASE = ['admin', 'user'] as const;

// Senhas de dev, fixas de propósito para o seed rodar sem configuração. Só existem porque o
// script aborta fora de dev/test — nunca são um segredo de produção.
const ADMIN = { email: 'admin@iam.local', senha: 'Admin@Dev123!', papel: 'admin' } as const;
const CARGA = { email: 'load@iam.local', senha: 'S3nh@DeCarga!', papel: 'user' } as const;

async function garantirRoles(pool: Pool): Promise<void> {
  for (const nome of ROLES_BASE) {
    await pool.query('INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [nome]);
  }
}

/** Cria o usuário (se não existir) e garante o vínculo com o papel — ambos idempotentes. */
async function garantirUsuarioComPapel(
  pool: Pool,
  servicoDeSenha: ServicoDeSenha,
  logger: Logger,
  dados: { email: string; senha: string; papel: string },
): Promise<void> {
  const hash = await servicoDeSenha.gerarHash(dados.senha);
  const { rowCount } = await pool.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (email) DO NOTHING`,
    [dados.email, hash],
  );

  // Vínculo por SELECT: resolve os ids por email/nome, funcionando tanto para o usuário
  // recém-criado quanto para um que já existia de um seed anterior.
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = $2
     ON CONFLICT DO NOTHING`,
    [dados.email, dados.papel],
  );

  logger.info(
    { email: dados.email, papel: dados.papel, criado: (rowCount ?? 0) > 0 },
    'seed.usuario_garantido',
  );
}

async function semear(): Promise<void> {
  const env = carregarEnv();
  const logger = criarLogger({ nivel: env.LOG_LEVEL });

  // Falha-fecha contra produção: as senhas acima são versionadas. Nunca semear prod.
  if (env.NODE_ENV === 'production') {
    logger.fatal('seed abortado: NODE_ENV=production — dados de seed nunca vão para produção');
    process.exit(1);
  }

  const pool = criarPoolPostgres(env);
  const servicoDeSenha = criarServicoDeSenhaDaEnv(env);

  try {
    await garantirRoles(pool);
    await garantirUsuarioComPapel(pool, servicoDeSenha, logger, ADMIN);
    await garantirUsuarioComPapel(pool, servicoDeSenha, logger, CARGA);
    logger.info('seed.concluido');
  } finally {
    await pool.end();
  }
}

semear().catch((erro: unknown) => {
  criarLogger().fatal({ err: erro }, 'falha ao semear');
  process.exit(1);
});
