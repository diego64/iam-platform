/**
 * Responsabilidade: hash e verificação de senhas com `scrypt` nativo do `node:crypto`.
 * Consumido por: (hash da senha inicial), a (verificação no login) e o
 * PasswordService desta SPEC (troca/reset).
 * Regras:
 *  - Formato de armazenamento versionado: `scrypt$N$r$p$saltB64$hashB64`. Os parâmetros
 *    viajam no hash, então `verificar` reconstrói o custo com que ele foi gerado e um
 *    `precisaRehash` pode comparar com o custo corrente.
 *  - Salt de 32 bytes por senha; hash de 64 bytes; comparação com `timingSafeEqual`.
 *  - Senha errada e hash malformado retornam `false` — nunca lançam. O motivo fica no
 *    domínio de quem chamou, nunca vaza pela exceção.
 *  - Parâmetros por injeção (não lê env): mantém o serviço testável sem process.env e
 *    coerente com a regra de dependência do projeto.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import type { Env } from '../../config/env.js';

// `promisify(scrypt)` resolve na sobrecarga de 3 argumentos (sem options), e esta SPEC
// precisa passar `maxmem` — por isso a assinatura de 4 argumentos é declarada explícita.
const scryptAsync = promisify<string, Buffer, number, ScryptOptions, Buffer>(scrypt);

/** Parâmetros de custo do `scrypt`. `custo` é o N (potência de 2), `blocos` é r, `paralelismo` é p. */
export interface ParametrosScrypt {
  readonly custo: number;
  readonly blocos: number;
  readonly paralelismo: number;
}

export interface ServicoDeSenha {
  gerarHash(senha: string): Promise<string>;
  verificar(senha: string, hashArmazenado: string): Promise<boolean>;
  /**
   * `true` quando o hash foi gerado com parâmetros diferentes dos correntes — sinal para
   * re-hash oportunista no próximo login bem-sucedido (tem a senha em claro em mãos
   * nesse instante). É como o custo evolui sem migração em massa. Hash malformado devolve
   * `true`: o formato mudou, precisa ser regravado.
   */
  precisaRehash(hashArmazenado: string): boolean;
  /**
   * Um hash real, de custo corrente, gerado a partir de segredo aleatório — nenhuma senha
   * o verifica como `true`. Compara contra ele quando o usuário não existe, para o
   * caminho "não existe" pagar exatamente o mesmo tempo do caminho legítimo e não
   * denunciar a ausência por timing. Gerado uma vez e reusado; um `setTimeout` fingindo o
   * custo seria frágil e mensurável, um hash real tem a distribuição de tempo certa.
   */
  hashFantasma(): Promise<string>;
}

const PREFIXO = 'scrypt';
const TAMANHO_SALT = 32;
const TAMANHO_HASH = 64;

/**
 * Teto de memória do `scrypt`, derivado dos parâmetros.
 *
 * O uso real é ~`128·N·r` bytes; com `N=2^15, r=8` dá exatamente 32 MiB, que é o teto
 * default do Node — e ali o `scrypt` aborta de forma intermitente conforme o overhead
 * interno. Derivar o teto dos parâmetros (com folga de 2×) garante que ele nunca é o
 * gargalo, seja no custo de produção, seja num custo maior no futuro. `maxmem` só limita:
 * ser generoso é seguro.
 */
function tetoDeMemoria(params: ParametrosScrypt): number {
  const necessario = 128 * params.custo * params.blocos * 2;
  return Math.max(necessario, 64 * 1024 * 1024);
}

/** Deriva a chave `scrypt` com os parâmetros informados. */
async function derivar(senha: string, salt: Buffer, params: ParametrosScrypt): Promise<Buffer> {
  return scryptAsync(senha, salt, TAMANHO_HASH, {
    N: params.custo,
    r: params.blocos,
    p: params.paralelismo,
    maxmem: tetoDeMemoria(params),
  });
}

/** Partes já decodificadas de um hash armazenado. */
interface HashDecodificado {
  readonly params: ParametrosScrypt;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/**
 * Decodifica `scrypt$N$r$p$saltB64$hashB64`.
 *
 * Devolve `null` em qualquer desvio de formato — parte ausente, prefixo errado, número
 * inválido, base64 corrompido. Quem chama trata `null` como "não confere", sem distinguir
 * do caso senha-errada: um atacante não aprende se o hash guardado está malformado.
 */
function decodificar(hashArmazenado: string): HashDecodificado | null {
  const partes = hashArmazenado.split('$');
  if (partes.length !== 6 || partes[0] !== PREFIXO) return null;

  const custo = Number(partes[1]);
  const blocos = Number(partes[2]);
  const paralelismo = Number(partes[3]);
  if (![custo, blocos, paralelismo].every((n) => Number.isInteger(n) && n > 0)) return null;

  try {
    const salt = Buffer.from(partes[4] ?? '', 'base64');
    const hash = Buffer.from(partes[5] ?? '', 'base64');
    if (salt.length !== TAMANHO_SALT || hash.length !== TAMANHO_HASH) return null;
    return { params: { custo, blocos, paralelismo }, salt, hash };
  } catch {
    return null;
  }
}

/**
 * Cria o serviço de senha com os parâmetros de custo informados.
 *
 * Recebe os parâmetros por injeção — a fábrica que lê env e monta isso é da T02.
 */
export function criarServicoDeSenha(params: ParametrosScrypt): ServicoDeSenha {
  async function gerarHash(senha: string): Promise<string> {
    const salt = randomBytes(TAMANHO_SALT);
    const hash = await derivar(senha, salt, params);
    return [
      PREFIXO,
      params.custo,
      params.blocos,
      params.paralelismo,
      salt.toString('base64'),
      hash.toString('base64'),
    ].join('$');
  }

  // Cacheia a PROMESSA, não o valor: a primeira chamada dispara o hash e as demais
  // aguardam a mesma, sem gerar vários fantasmas nem serializar chamadas concorrentes.
  let fantasma: Promise<string> | undefined;

  return {
    gerarHash,

    async verificar(senha: string, hashArmazenado: string): Promise<boolean> {
      const decodificado = decodificar(hashArmazenado);
      if (decodificado === null) return false;

      // Rederiva com os parâmetros DO HASH, não os correntes: um hash antigo, de custo
      // menor, ainda precisa verificar — o re-hash para o custo novo é oportunista (T02).
      const candidato = await derivar(senha, decodificado.salt, decodificado.params);

      // Comprimentos iguais por construção (ambos 64 bytes); o guard protege o
      // timingSafeEqual, que lança se os buffers diferem em tamanho.
      return (
        candidato.length === decodificado.hash.length &&
        timingSafeEqual(candidato, decodificado.hash)
      );
    },

    precisaRehash(hashArmazenado: string): boolean {
      const decodificado = decodificar(hashArmazenado);
      if (decodificado === null) return true;

      const atual = decodificado.params;
      return (
        atual.custo !== params.custo ||
        atual.blocos !== params.blocos ||
        atual.paralelismo !== params.paralelismo
      );
    },

    hashFantasma(): Promise<string> {
      // Segredo aleatório de 32 bytes: nenhuma senha real vai colidir com ele.
      fantasma ??= gerarHash(randomBytes(32).toString('base64'));
      return fantasma;
    },
  };
}

/** Mapeia as variáveis de ambiente validadas para os parâmetros do scrypt. */
export function parametrosDaEnv(env: Env): ParametrosScrypt {
  return {
    custo: env.SCRYPT_COST,
    blocos: env.SCRYPT_BLOCK_SIZE,
    paralelismo: env.SCRYPT_PARALLELIZATION,
  };
}

/** Cria o serviço já com os parâmetros vindos da configuração — usado no bootstrap. */
export function criarServicoDeSenhaDaEnv(env: Env): ServicoDeSenha {
  return criarServicoDeSenha(parametrosDaEnv(env));
}
