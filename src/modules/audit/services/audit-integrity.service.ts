/**
 * Responsabilidade: recomputar a cadeia num intervalo e confrontá-la com a âncora, dizendo
 * se a trilha foi alterada — e onde.
 * Consumido por: a rota de verificação e o runbook de recuperação.
 * Regras:
 *  - Percorre em ordem e encerra na primeira divergência: depois dela, todo hash seguinte
 *    diverge por consequência, e listar isso esconderia o ponto que interessa.
 *  - Quatro formas de quebra, porque são quatro ataques diferentes: valor alterado
 *    (`hash-divergente`), elo remendado (`elo-quebrado`), evento removido do meio
 *    (`seq-faltante`) e trilha cortada no fim (`checkpoint-divergente`).
 *  - A âncora é conferida sempre, mesmo com a cadeia íntegra: é justamente o caso do
 *    truncamento, em que o que sobrou é coerente consigo mesmo.
 *  - Janela acima do teto é recusada. Verificar milhões de eventos numa requisição prende um
 *    processo e devolve uma resposta que ninguém está mais esperando.
 */
import { ErroDeAuditoria } from '../errors/audit.errors.js';
import { HASH_DE_GENESE } from '../types/audit-event.js';
import type { RepositorioDaTrilha } from '../repositories/audit-log.repository.js';
import type { RepositorioDeCheckpoint } from '../repositories/audit-checkpoint.repository.js';
import { calcularHashDoElo, corpoDe } from './chain-hash.js';

export type MotivoDeQuebra =
  'hash-divergente' | 'elo-quebrado' | 'seq-faltante' | 'checkpoint-divergente';

export interface Quebra {
  readonly seq: number;
  readonly motivo: MotivoDeQuebra;
}

export interface ConferenciaDeCheckpoint {
  readonly seq: number;
  readonly hash: string;
  readonly confere: boolean;
}

export interface RelatorioDeIntegridade {
  readonly integra: boolean;
  readonly de: number;
  readonly ate: number;
  readonly verificados: number;
  readonly primeiraQuebra: Quebra | null;
  readonly checkpointConferido: ConferenciaDeCheckpoint | null;
}

export interface DependenciasDaIntegridade {
  readonly trilha: RepositorioDaTrilha;
  readonly checkpoints: RepositorioDeCheckpoint;
  readonly janelaMaxima: number;
}

export interface AuditIntegrityService {
  verificar(faixa: { de: number; ate?: number }): Promise<RelatorioDeIntegridade>;
}

export function criarAuditIntegrityService(deps: DependenciasDaIntegridade): AuditIntegrityService {
  /**
   * Confere a âncora contra a trilha.
   *
   * A âncora usada é a **última** gravada, não a última dentro da janela: quem corta o fim
   * da trilha também encolhe o topo, e uma âncora escolhida pelo topo atual acompanharia o
   * corte sem reclamar. Uma âncora à frente do topo é, por si só, prova de truncamento.
   */
  async function conferirAncora(topoAtual: number): Promise<ConferenciaDeCheckpoint | null> {
    const ancora = await deps.checkpoints.ultimo();
    if (ancora === null) return null;

    if (ancora.seq > topoAtual) {
      return { seq: ancora.seq, hash: ancora.hash, confere: false };
    }
    const evento = await deps.trilha.buscarPorSeq(ancora.seq);
    return {
      seq: ancora.seq,
      hash: ancora.hash,
      confere: evento !== null && evento.hash === ancora.hash,
    };
  }

  return {
    async verificar(faixa): Promise<RelatorioDeIntegridade> {
      let topoAtual: number;
      try {
        topoAtual = (await deps.trilha.topo()).seq;
      } catch (erro) {
        throw erro instanceof ErroDeAuditoria ? erro : new ErroDeAuditoria('trilha-indisponivel');
      }

      const de = faixa.de;
      const ate = faixa.ate ?? topoAtual;
      if (ate >= de && ate - de + 1 > deps.janelaMaxima) {
        throw new ErroDeAuditoria('janela-grande-demais');
      }

      try {
        // O elo esperado do primeiro item vem do evento anterior à janela. Começando em 1,
        // é a gênese; começando no meio, é o hash do vizinho de trás. Sem ele — porque a
        // janela começa num ponto cujo antecessor não existe —, a primeira ligação fica sem
        // referência e só o hash próprio do evento é verificável.
        let elo: string | null =
          de <= 1 ? HASH_DE_GENESE : ((await deps.trilha.buscarPorSeq(de - 1))?.hash ?? null);

        let esperado = de;
        let verificados = 0;
        let quebra: Quebra | null = null;

        for await (const evento of deps.trilha.lerFaixa(de, ate)) {
          if (evento.seq !== esperado) {
            quebra = { seq: esperado, motivo: 'seq-faltante' };
            break;
          }
          if (elo !== null && evento.prevHash !== elo) {
            quebra = { seq: evento.seq, motivo: 'elo-quebrado' };
            break;
          }
          if (calcularHashDoElo(evento.seq, evento.prevHash, corpoDe(evento)) !== evento.hash) {
            quebra = { seq: evento.seq, motivo: 'hash-divergente' };
            break;
          }

          elo = evento.hash;
          esperado += 1;
          verificados += 1;
        }

        // Faixa que termina antes do pedido: os eventos do fim sumiram sem que nenhum elo
        // apontasse para eles. A posição acusada é a primeira que faltou.
        if (quebra === null && esperado <= Math.min(ate, topoAtual)) {
          quebra = { seq: esperado, motivo: 'seq-faltante' };
        }

        const checkpointConferido = await conferirAncora(topoAtual);
        if (quebra === null && checkpointConferido !== null && !checkpointConferido.confere) {
          quebra = { seq: checkpointConferido.seq, motivo: 'checkpoint-divergente' };
        }

        return {
          integra: quebra === null,
          de,
          ate,
          verificados,
          primeiraQuebra: quebra,
          checkpointConferido,
        };
      } catch (erro) {
        throw erro instanceof ErroDeAuditoria ? erro : new ErroDeAuditoria('trilha-indisponivel');
      }
    },
  };
}
