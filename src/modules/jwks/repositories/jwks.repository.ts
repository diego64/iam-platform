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

/**
 * Chave do advisory lock que serializa rotações. Valor arbitrário e fixo — o que importa é
 * que toda réplica use o mesmo. `pg_try_advisory_xact_lock` é transacional: o lock cai
 * sozinho no commit, no rollback e na queda da conexão, então não há lock órfão para
 * limpar depois de um crash.
 */
const LOCK_DE_ROTACAO = 1_786_080_115;

/**
 * Resultado da rotação. As recusas são estado de retorno, não exceção: recusar por falta de
 * chave pré-publicada ou por concorrência é caminho esperado, e o controller precisa
 * distingui-las para escolher o `type` do problem+json.
 */
export type ResultadoDeRotacao =
  | {
      readonly situacao: 'rotacionada';
      readonly kidAnterior: string | null;
      readonly kidAtivo: string;
    }
  | { readonly situacao: 'sem-proxima' }
  | { readonly situacao: 'lock-ocupado' };

export interface OpcoesDeRotacao {
  /**
   * Por quanto tempo a chave aposentada ainda verifica tokens. Zero encerra na hora — é
   * como a revogação de emergência reusa esta mesma transação.
   */
  readonly graceMs: number;
}

export interface RepositorioJwks {
  inserir(entrada: EntradaDeChave): Promise<ChaveJwks>;
  /**
   * Aposenta a `active` e promove a `next`, numa transação.
   *
   * A ordem importa: promover antes de aposentar violaria o índice único de chave ativa, que
   * o PostgreSQL verifica a cada instrução. O `SELECT ... FOR UPDATE` no início serializa
   * rotações concorrentes — a segunda transação acorda com a promoção já feita, não encontra
   * mais uma `next` e desiste, em vez de aposentar a chave recém-promovida.
   */
  rotacionar(opcoes: OpcoesDeRotacao): Promise<ResultadoDeRotacao>;
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
  obterMetadadosPorKid(kid: string): Promise<MetadadosDeChave | null>;
  /**
   * Encerra a verificabilidade da chave agora — a revogação de emergência.
   *
   * Recusa-se a tocar na chave `active` (devolve `null`): sem promover a pré-publicada no
   * mesmo commit, revogar a ativa deixaria o IdP sem chave de assinatura. Esse caminho é o
   * `rotacionar` com janela zero; aqui ficam só `next` e `retired`.
   */
  revogar(kid: string): Promise<MetadadosDeChave | null>;
  /** Apaga chaves que já não verificam nada há mais que a margem. Devolve quantas saíram. */
  purgar(margemMs: number): Promise<number>;
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

    async rotacionar(opcoes: OpcoesDeRotacao): Promise<ResultadoDeRotacao> {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');

        // Try-lock, não lock bloqueante: com N réplicas acordando no mesmo minuto, as N-1
        // perdedoras precisam desistir na hora, não enfileirar para rotacionar em seguida.
        const { rows: lock } = await cliente.query<{ obtido: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1) AS obtido',
          [LOCK_DE_ROTACAO],
        );
        if (lock[0]?.obtido !== true) {
          await cliente.query('ROLLBACK');
          return { situacao: 'lock-ocupado' };
        }

        const { rows: envolvidas } = await cliente.query<{ kid: string; status: StatusDaChave }>(
          `SELECT kid, status FROM jwks WHERE status IN ('active', 'next') FOR UPDATE`,
        );
        const proxima = envolvidas.find((l) => l.status === 'next');
        if (proxima === undefined) {
          await cliente.query('ROLLBACK');
          return { situacao: 'sem-proxima' };
        }
        const anterior = envolvidas.find((l) => l.status === 'active') ?? null;

        await cliente.query(
          `UPDATE jwks
              SET status = 'retired',
                  retired_at = now(),
                  verifiable_until = now() + ($1::bigint * interval '1 millisecond')
            WHERE status = 'active'`,
          [opcoes.graceMs],
        );
        await cliente.query(
          `UPDATE jwks SET status = 'active', activated_at = now() WHERE status = 'next'`,
        );

        await cliente.query('COMMIT');
        return {
          situacao: 'rotacionada',
          kidAnterior: anterior?.kid ?? null,
          kidAtivo: proxima.kid,
        };
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
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

    async obterMetadadosPorKid(kid: string): Promise<MetadadosDeChave | null> {
      const { rows } = await pool.query<LinhaDeMetadados>(
        `SELECT ${COLUNAS_METADADOS} FROM jwks WHERE kid = $1`,
        [kid],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraMetadados(linha);
    },

    async revogar(kid: string): Promise<MetadadosDeChave | null> {
      const { rows } = await pool.query<LinhaDeMetadados>(
        `UPDATE jwks
            SET status = 'retired',
                retired_at = COALESCE(retired_at, now()),
                verifiable_until = now()
          WHERE kid = $1 AND status <> 'active'
          RETURNING ${COLUNAS_METADADOS}`,
        [kid],
      );
      const linha = rows[0];
      return linha === undefined ? null : paraMetadados(linha);
    },

    async purgar(margemMs: number): Promise<number> {
      // Só sai o que já não verifica nada há mais que a margem. A comparação é estritamente
      // menor: uma chave cujo fim de verificabilidade é agora ainda pode ter token vivo.
      const { rowCount } = await pool.query(
        `DELETE FROM jwks
          WHERE status = 'retired'
            AND verifiable_until IS NOT NULL
            AND verifiable_until < now() - ($1::bigint * interval '1 millisecond')`,
        [margemMs],
      );
      return rowCount ?? 0;
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
