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
import type {
  ChaveJwks,
  JwkPublica,
  MetadadosDeChave,
  StatusDaChave,
} from '../types/jwks.types.js';

const COLUNAS_METADADOS =
  'kid, algorithm, status, created_at, activated_at, retired_at, verifiable_until';
const COLUNAS = `kid, algorithm, public_jwk, private_key_enc, status, created_at, activated_at, retired_at, verifiable_until`;

interface LinhaDeMetadados {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly status: StatusDaChave;
  readonly created_at: Date;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
  readonly verifiable_until: Date | null;
}

interface LinhaJwks extends LinhaDeMetadados {
  readonly public_jwk: JwkPublica;
  readonly private_key_enc: Buffer;
}

function paraMetadados(linha: LinhaDeMetadados): MetadadosDeChave {
  return {
    kid: linha.kid,
    algorithm: linha.algorithm,
    status: linha.status,
    criadaEm: linha.created_at,
    ativadaEm: linha.activated_at,
    aposentadaEm: linha.retired_at,
    verificavelAte: linha.verifiable_until,
  };
}

function paraEntidade(linha: LinhaJwks): ChaveJwks {
  return {
    ...paraMetadados(linha),
    publicJwk: linha.public_jwk,
    privateKeyEnc: linha.private_key_enc,
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
  /** A chave pré-publicada, se houver. O índice único garante que é no máximo uma. */
  obterProxima(): Promise<ChaveJwks | null>;
  /**
   * active + next + retired que ainda verifica (`verifiable_until > agora`).
   *
   * A janela não é parâmetro: ela já está materializada em `verifiable_until` desde o
   * momento da aposentadoria, então mudar a configuração de graça não ressuscita chave
   * nenhuma nem encurta a vida das que já foram aposentadas sob a janela anterior.
   */
  listarElegiveis(agora: Date): Promise<ChaveJwks[]>;
  /** Metadados para a superfície administrativa — sem tocar no material cifrado. */
  listarMetadados(filtro?: { status?: StatusDaChave }): Promise<MetadadosDeChave[]>;
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

    async obterProxima(): Promise<ChaveJwks | null> {
      const { rows } = await pool.query<LinhaJwks>(
        `SELECT ${COLUNAS} FROM jwks WHERE status = 'next'`,
      );
      const linha = rows[0];
      return linha === undefined ? null : paraEntidade(linha);
    },

    async listarElegiveis(agora: Date): Promise<ChaveJwks[]> {
      const { rows } = await pool.query<LinhaJwks>(
        `SELECT ${COLUNAS} FROM jwks
         WHERE status IN ('active', 'next')
            OR (verifiable_until IS NOT NULL AND verifiable_until > $1)
         ORDER BY created_at DESC`,
        [agora],
      );
      return rows.map(paraEntidade);
    },

    async listarMetadados(filtro: { status?: StatusDaChave } = {}): Promise<MetadadosDeChave[]> {
      // Uma consulta só, com o filtro opcional resolvido no próprio SQL: `$1 IS NULL` deixa
      // o parâmetro ausente casar com tudo, sem montar string condicional.
      const { rows } = await pool.query<LinhaDeMetadados>(
        `SELECT ${COLUNAS_METADADOS} FROM jwks
          WHERE $1::text IS NULL OR status = $1::text
          ORDER BY created_at DESC`,
        [filtro.status ?? null],
      );
      return rows.map(paraMetadados);
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
