/**
 * Responsabilidade: a âncora do topo da cadeia no PostgreSQL.
 * Consumido por: o serviço de auditoria (grava) e o de verificação (confere).
 * Regras:
 *  - `Pool` por injeção; SQL parametrizado.
 *  - Gravar a mesma posição duas vezes é reexecução, não um segundo fato: `ON CONFLICT DO
 *    NOTHING` torna a operação repetível sem erro e sem duplicar a âncora.
 *  - Vive em banco diferente da trilha de propósito. Quem apaga o fim da trilha e reajusta
 *    o topo produz uma cadeia coerente consigo mesma; só uma âncora fora do alcance dele
 *    denuncia o truncamento.
 */
import type { Pool } from 'pg';

export interface Checkpoint {
  readonly seq: number;
  readonly hash: string;
  readonly criadoEm: Date;
}

interface LinhaDeCheckpoint {
  readonly seq: string;
  readonly hash: string;
  readonly created_at: Date;
}

function paraEntidade(linha: LinhaDeCheckpoint): Checkpoint {
  // `BIGINT` chega como string no driver: converter aqui evita comparação entre string e
  // número lá na frente, que passaria despercebida e compararia errado.
  return { seq: Number(linha.seq), hash: linha.hash, criadoEm: linha.created_at };
}

export interface RepositorioDeCheckpoint {
  gravar(seq: number, hash: string): Promise<void>;
  /** O checkpoint aplicável até a posição dada, ou `null` se ainda não houver nenhum. */
  ultimoAte(seq: number): Promise<Checkpoint | null>;
  ultimo(): Promise<Checkpoint | null>;
}

const COLUNAS = 'seq, hash, created_at';

export function criarRepositorioDeCheckpoint(pool: Pool): RepositorioDeCheckpoint {
  return {
    async gravar(seq: number, hash: string): Promise<void> {
      await pool.query(
        'INSERT INTO audit_checkpoints (seq, hash) VALUES ($1, $2) ON CONFLICT (seq) DO NOTHING',
        [seq, hash],
      );
    },

    async ultimoAte(seq: number): Promise<Checkpoint | null> {
      const { rows } = await pool.query<LinhaDeCheckpoint>(
        `SELECT ${COLUNAS} FROM audit_checkpoints WHERE seq <= $1 ORDER BY seq DESC LIMIT 1`,
        [seq],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async ultimo(): Promise<Checkpoint | null> {
      const { rows } = await pool.query<LinhaDeCheckpoint>(
        `SELECT ${COLUNAS} FROM audit_checkpoints ORDER BY seq DESC LIMIT 1`,
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },
  };
}
