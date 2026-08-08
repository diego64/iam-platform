/**
 * Recria a tabela de âncoras aplicando a própria DDL da migração, em vez de um `CREATE
 * TABLE` inline: o teste exercita o mesmo SQL que vai a produção, inclusive o `UNIQUE` em
 * `seq` de que a idempotência da gravação depende.
 *
 * A migração também semeia permissões, e o seed depende da tabela `permissions`. Nos testes
 * que só querem a âncora, a parte do seed é recortada — recriar o RBAC inteiro aqui
 * acoplaria a suíte de auditoria a outra migração sem necessidade.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

const MIGRACAO = readFileSync(
  new URL('../../../src/database/migrations/0008_audit_checkpoints.sql', import.meta.url),
  'utf8',
);

/** Só as instruções de estrutura: tudo até o primeiro INSERT do seed. */
const DDL_CHECKPOINTS = MIGRACAO.split(/^INSERT INTO/m)[0] ?? '';

export async function recriarCheckpoints(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS audit_checkpoints CASCADE');
  await pool.query(DDL_CHECKPOINTS);
}
