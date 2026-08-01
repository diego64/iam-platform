/**
 * Responsabilidade: acesso à tabela `jwks` em PostgreSQL.
 * Consumido por: o serviço de chaves (leitura no boot e refresh) e o script de bootstrap.
 * Regras:
 *  - Recebe o `Pool` por injeção — nunca importa singleton de conexão.
 *  - SQL sempre parametrizado; colunas nominais (nada de `SELECT *`).
 *  - A invariante "no máximo 1 active" é do índice único parcial na coluna status; o
 *    repositório apenas propaga a violação de unicidade (23505) — quem previne o insert
 *    duplicado é a checagem de idempotência do bootstrap.
 */
import type { Pool } from 'pg';
import type { ChaveJwks, JwkPublica, StatusDaChave } from '../types/jwks.types.js';

const COLUNAS =
  'kid, algorithm, public_jwk, private_key_enc, status, created_at, activated_at, retired_at';

interface LinhaJwks {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly public_jwk: JwkPublica;
  readonly private_key_enc: Buffer;
  readonly status: StatusDaChave;
  readonly created_at: Date;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
}

function paraEntidade(linha: LinhaJwks): ChaveJwks {
  return {
    kid: linha.kid,
    algorithm: linha.algorithm,
    publicJwk: linha.public_jwk,
    privateKeyEnc: linha.private_key_enc,
    status: linha.status,
    criadaEm: linha.created_at,
    ativadaEm: linha.activated_at,
    aposentadaEm: linha.retired_at,
  };
}

export interface EntradaDeChave {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly publicJwk: JwkPublica;
  readonly privateKeyEnc: Buffer;
  readonly status: StatusDaChave;
}

export interface RepositorioJwks {
  inserir(entrada: EntradaDeChave): Promise<ChaveJwks>;
  obterAtiva(): Promise<ChaveJwks | null>;
  /** active + next + retired ainda dentro da janela de graça (`aposentada_em > agora - grace`). */
  listarElegiveis(agora: Date, graceMs: number): Promise<ChaveJwks[]>;
  contarPorStatus(): Promise<Record<StatusDaChave, number>>;
}

export function criarRepositorioJwks(pool: Pool): RepositorioJwks {
  return {
    async inserir(entrada: EntradaDeChave): Promise<ChaveJwks> {
      const { rows } = await pool.query<LinhaJwks>(
        `INSERT INTO jwks (kid, algorithm, public_jwk, private_key_enc, status, activated_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'active' THEN now() ELSE NULL END)
         RETURNING ${COLUNAS}`,
        [
          entrada.kid,
          entrada.algorithm,
          JSON.stringify(entrada.publicJwk),
          entrada.privateKeyEnc,
          entrada.status,
        ],
      );
      // INSERT ... RETURNING sempre devolve a linha; o não-nulo é garantido.
      return paraEntidade(rows[0] as LinhaJwks);
    },

    async obterAtiva(): Promise<ChaveJwks | null> {
      const { rows } = await pool.query<LinhaJwks>(
        `SELECT ${COLUNAS} FROM jwks WHERE status = 'active'`,
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async listarElegiveis(agora: Date, graceMs: number): Promise<ChaveJwks[]> {
      const corte = new Date(agora.getTime() - graceMs);
      const { rows } = await pool.query<LinhaJwks>(
        `SELECT ${COLUNAS} FROM jwks
         WHERE status IN ('active', 'next')
            OR (status = 'retired' AND retired_at IS NOT NULL AND retired_at > $1)
         ORDER BY created_at DESC`,
        [corte],
      );
      return rows.map(paraEntidade);
    },

    async contarPorStatus(): Promise<Record<StatusDaChave, number>> {
      const { rows } = await pool.query<{ status: StatusDaChave; total: string }>(
        'SELECT status, count(*)::text AS total FROM jwks GROUP BY status',
      );
      const contagem: Record<StatusDaChave, number> = { active: 0, next: 0, retired: 0 };
      for (const linha of rows) {
        contagem[linha.status] = Number(linha.total);
      }
      return contagem;
    },
  };
}
