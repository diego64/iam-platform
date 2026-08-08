/**
 * Responsabilidade: os números da tela inicial do painel, numa chamada só.
 * Consumido por: o controller do painel administrativo.
 * Regras:
 *  - As fontes são consultadas em paralelo e avaliadas uma a uma. Fonte acessória que falha
 *    vira campo nulo com `parcial: true`; derrubar a tela inteira por causa de um contador
 *    tiraria o painel do ar exatamente durante o incidente em que ele é mais necessário.
 *  - A contagem de usuários é a exceção: sem ela não existe visão administrativa nenhuma, e
 *    a falha vira 503. É a diferença entre "um número faltou" e "os dados não vieram".
 *  - O resultado é cacheado por uma janela curta e a resposta declara o instante da
 *    apuração — o painel mostra a idade do dado em vez de fingir tempo real.
 */
import { criarCacheComTtl, type CacheComTtl } from '../../../shared/cache/ttl-cache.js';
import { ErroDeAdmin } from '../errors/admin.errors.js';
import type {
  LeitorDeAuditoria,
  LeitorDeChaveAtiva,
  LeitorDeClientes,
  LeitorDeSessoes,
  LeitorDeUsuarios,
} from '../interfaces/portas.js';

const CHAVE = 'overview';
const UM_DIA_MS = 24 * 60 * 60 * 1000;

export interface VisaoGeral {
  readonly apuradoEm: Date;
  readonly parcial: boolean;
  readonly usuarios: { readonly active: number; readonly blocked: number; readonly total: number };
  readonly sessoesAtivas: number | null;
  readonly logins24h: { readonly sucesso: number; readonly falha: number } | null;
  readonly clientesAtivos: number | null;
  readonly chaveAtiva: { readonly kid: string; readonly idadeDias: number } | null;
}

export interface ResultadoDaVisaoGeral {
  readonly visao: VisaoGeral;
  readonly doCache: boolean;
}

export interface DependenciasDaVisaoGeral {
  readonly usuarios: LeitorDeUsuarios;
  readonly sessoes: LeitorDeSessoes;
  readonly auditoria: LeitorDeAuditoria;
  readonly clientes: LeitorDeClientes;
  readonly chaves: LeitorDeChaveAtiva;
  readonly janelaDeCacheMs: number;
  readonly agora?: () => number;
  readonly medidor?: { contarParcial(fonte: string): void };
}

export interface OverviewService {
  obter(): Promise<ResultadoDaVisaoGeral>;
}

/** `null` no lugar do valor quando a fonte falhou — e o nome da fonte, para a métrica. */
function valorDe<T>(resultado: PromiseSettledResult<T>): T | null {
  return resultado.status === 'fulfilled' ? resultado.value : null;
}

export function criarOverviewService(deps: DependenciasDaVisaoGeral): OverviewService {
  const agora = deps.agora ?? Date.now;
  const cache: CacheComTtl<VisaoGeral> = criarCacheComTtl<VisaoGeral>(deps.janelaDeCacheMs, agora);

  async function apurar(): Promise<VisaoGeral> {
    const desde = new Date(agora() - UM_DIA_MS);
    const [porStatus, sessoes, sucessos, falhas, clientes, chave] = await Promise.allSettled([
      deps.usuarios.contarPorStatus(),
      deps.sessoes.contarAtivas(),
      deps.auditoria.contarPorTipoDesde('iam.auth.login', desde),
      deps.auditoria.contarPorTipoDesde('iam.auth.login_failed', desde),
      deps.clientes.contarAtivos(),
      deps.chaves.obter(),
    ]);

    const contagem = valorDe(porStatus);
    if (contagem === null) throw new ErroDeAdmin('fonte-essencial-indisponivel');

    const sessoesAtivas = valorDe(sessoes);
    const clientesAtivos = valorDe(clientes);
    const chaveAtiva = valorDe(chave);
    // Os dois contadores de login vêm da mesma fonte: um sem o outro seria uma taxa de
    // falha inventada, então ou os dois entram, ou nenhum entra.
    const logins24h =
      sucessos.status === 'fulfilled' && falhas.status === 'fulfilled'
        ? { sucesso: sucessos.value, falha: falhas.value }
        : null;

    const ausentes: [string, boolean][] = [
      ['sessoes', sessoesAtivas === null],
      ['auditoria', logins24h === null],
      ['clientes', clientesAtivos === null],
      ['chaves', chave.status === 'rejected'],
    ];
    for (const [fonte, faltou] of ausentes) {
      if (faltou) deps.medidor?.contarParcial(fonte);
    }

    return {
      apuradoEm: new Date(agora()),
      parcial: ausentes.some(([, faltou]) => faltou),
      usuarios: {
        active: contagem.active,
        blocked: contagem.blocked,
        total: contagem.active + contagem.blocked,
      },
      sessoesAtivas,
      logins24h,
      clientesAtivos,
      chaveAtiva:
        chaveAtiva === null
          ? null
          : {
              kid: chaveAtiva.kid,
              idadeDias: Math.floor((agora() - chaveAtiva.criadaEm.getTime()) / UM_DIA_MS),
            },
    };
  }

  return {
    async obter(): Promise<ResultadoDaVisaoGeral> {
      const guardada = cache.obter(CHAVE);
      if (guardada !== null) return { visao: guardada, doCache: true };

      const visao = await apurar();
      cache.gravar(CHAVE, visao);
      return { visao, doCache: false };
    },
  };
}
