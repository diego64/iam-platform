/**
 * Responsabilidade: criar o Pool do pg a partir da configuração e provar a conexão no boot.
 * Regras: recebe `env` por parâmetro — nunca importa singleton de configuração. Repositórios
 *         recebem Pool/PoolClient por construtor — proibido importar este módulo dentro de modules/.
 */
import pg from 'pg';
import type { Env } from '../../config/env.js';

export const TIMEOUT_DE_CONEXAO_MS = 5_000;

/**
 * Se o host do banco pertence ao Render. Compara o **hostname** parseado, não uma substring da
 * URL inteira: `url.includes('render.com')` casaria com `render.com.atacante.com` ou com
 * `render.com` no caminho/senha. Só o sufixo de host `.render.com` (ou o domínio exato) vale.
 */
function ehHostGerenciadoDoRender(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'render.com' || host.endsWith('.render.com');
  } catch {
    return false; // URL malformada: não trata como Render
  }
}

/**
 * TLS do pool. Só liga onde o provedor gerenciado exige (Render); local e teste seguem sem TLS.
 * A verificação do certificado fica **sempre ligada** — desligá-la aceitaria qualquer
 * certificado e abriria caminho para MITM. Quando o certificado do provedor não está no bundle
 * de CAs do sistema, o CA entra por `POSTGRES_CA_CERT` e a verificação passa a usá-lo.
 */
function configurarSsl(env: Env): pg.PoolConfig['ssl'] {
  if (!ehHostGerenciadoDoRender(env.POSTGRES_URL)) return undefined;
  return {
    rejectUnauthorized: true,
    ...(env.POSTGRES_CA_CERT === undefined ? {} : { ca: env.POSTGRES_CA_CERT }),
  };
}

export function criarPoolPostgres(env: Env): pg.Pool {
  return new pg.Pool({
    connectionString: env.POSTGRES_URL,
    max: env.POSTGRES_POOL_MAX,
    connectionTimeoutMillis: TIMEOUT_DE_CONEXAO_MS,
    ssl: configurarSsl(env),
  });
}

/**
 * Verifica que o pool realmente fala com o banco, com retry para absorver
 * cold start / blips transitórios de conexão no boot.
 */
export async function verificarPostgres(
  pool: pg.Pool,
  tentativas = 5,
  delayMs = 2_000,
): Promise<void> {
  let ultimoErro: unknown;

  for (let i = 1; i <= tentativas; i++) {
    try {
      const cliente = await pool.connect();
      try {
        await cliente.query('SELECT 1');
        return; // sucesso, sai da função
      } finally {
        cliente.release();
      }
    } catch (err) {
      ultimoErro = err;
      if (i < tentativas) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw ultimoErro;
}
