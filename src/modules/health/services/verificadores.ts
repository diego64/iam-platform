/**
 * Responsabilidade: verificar se cada dependência responde, sem lançar.
 * Consumido por: o serviço de prontidão.
 * Regras:
 *  - Nunca propaga exceção: erro vira `down` com categoria. Exceção não tratada aqui
 *    viraria 500, e o orquestrador concluiria "fora" sem diagnóstico algum.
 *  - Nunca expõe mensagem do driver: ela costuma trazer host, usuário e porta, e a
 *    resposta de /health/ready é pública e sem autenticação.
 *  - Usa consulta trivial, sem tocar em schema: erro de migração não é indisponibilidade.
 */
import type { Pool } from 'pg';
import type { Db } from 'mongodb';

export type NomeDeDependencia = 'postgres' | 'mongodb';
export type MotivoDeFalha = 'timeout' | 'indisponivel' | 'erro_interno';

export interface EstadoDeDependencia {
  readonly nome: NomeDeDependencia;
  readonly estado: 'up' | 'down';
  readonly duracao_ms: number;
  readonly motivo?: MotivoDeFalha;
}

/** Assinatura de um verificador, para o serviço de prontidão receber por injeção. */
export type Verificador = () => Promise<EstadoDeDependencia>;

/** Sentinela devolvido quando o teto de tempo estoura antes da resposta. */
const ESTOUROU = Symbol('estourou');

/**
 * Corre a promessa contra o relógio.
 *
 * Necessário porque os drivers têm timeout próprio, geralmente mais generoso que o da
 * sonda: uma dependência que aceita a conexão mas nunca responde deixaria a requisição
 * pendurada além do que o orquestrador espera, e ele mataria a checagem sem obter
 * resposta — concluindo "fora" sem saber de quê.
 */
async function comTeto<T>(promessa: Promise<T>, tetoMs: number): Promise<T | typeof ESTOUROU> {
  let cancelar: ReturnType<typeof setTimeout> | undefined;

  const relogio = new Promise<typeof ESTOUROU>((resolver) => {
    cancelar = setTimeout(() => {
      resolver(ESTOUROU);
    }, tetoMs);
  });

  try {
    return await Promise.race([promessa, relogio]);
  } finally {
    if (cancelar !== undefined) clearTimeout(cancelar);
  }
}

/**
 * Classifica a falha sem olhar a mensagem do driver.
 *
 * Recusa de conexão e credencial errada caem ambas em `indisponivel`, de propósito:
 * distinguir as duas na resposta pública transformaria o endpoint em oráculo sobre a
 * infraestrutura para quem estivesse sondando.
 */
function classificar(erro: unknown): MotivoDeFalha {
  return erro instanceof Error ? 'indisponivel' : 'erro_interno';
}

/** Executa a checagem medindo a duração e traduzindo qualquer desfecho em estado. */
async function verificar(
  nome: NomeDeDependencia,
  checagem: () => Promise<unknown>,
  tetoMs: number,
): Promise<EstadoDeDependencia> {
  const inicio = Date.now();

  try {
    const desfecho = await comTeto(checagem(), tetoMs);
    const duracao_ms = Date.now() - inicio;

    return desfecho === ESTOUROU
      ? { nome, estado: 'down', duracao_ms, motivo: 'timeout' }
      : { nome, estado: 'up', duracao_ms };
  } catch (erro) {
    return {
      nome,
      estado: 'down',
      duracao_ms: Date.now() - inicio,
      motivo: classificar(erro),
    };
  }
}

/**
 * `SELECT 1` prova que a conexão está viva e o servidor responde. Consultar tabela real
 * acoplaria a prontidão ao schema, e uma migração incompleta viraria "serviço fora" —
 * detectar isso é trabalho do dry-run de migração, não do readiness.
 */
export function criarVerificadorPostgres(pool: Pool, tetoMs: number): Verificador {
  return () => verificar('postgres', () => pool.query('SELECT 1'), tetoMs);
}

/** `ping` é comando administrativo: não depende de coleção existente. */
export function criarVerificadorMongo(banco: Db, tetoMs: number): Verificador {
  return () => verificar('mongodb', () => banco.admin().command({ ping: 1 }), tetoMs);
}
