/**
 * Responsabilidade: a trilha encadeada no MongoDB — anexar eventos, ler faixas e paginar.
 * Consumido por: o serviço de auditoria e o de verificação de integridade.
 * Regras:
 *  - Recebe o `Db` por injeção. Os índices são de `garantirIndices`.
 *  - Escreve **apenas** por inserção. Não existe aqui método que atualize ou remova um
 *    evento; o único `updateOne` do arquivo é sobre o documento de topo, que é ponteiro,
 *    não é trilha.
 *  - A posição na cadeia é reservada por compare-and-set no documento único de topo: quem
 *    perde a corrida relê e tenta de novo, até o teto. Sem isso, duas réplicas leriam o
 *    mesmo `prev_hash` e bifurcariam a cadeia em silêncio.
 *  - A ordem é CAS primeiro, inserção depois. Morrer no meio deixa uma posição reservada e
 *    não materializada, que a verificação acusa como buraco. A ordem inversa deixaria dois
 *    eventos disputando o mesmo `seq` com a cadeia já bifurcada.
 */
import type { Db, Filter } from 'mongodb';
import type {
  AlvoDoEvento,
  AtorDoEvento,
  EventoPersistido,
  TopoDaCadeia,
  ValorDeMetadata,
} from '../types/audit-event.js';
import { HASH_DE_GENESE } from '../types/audit-event.js';
import type { MotivoDeEvento, ResultadoDeEvento, TipoDeEvento } from '../constants/event-types.js';

const COLECAO_TRILHA = 'audit_log';
const COLECAO_TOPO = 'audit_chain_head';
const ID_DO_TOPO = 'head';

/** O evento pronto para anexar: falta só a posição e o encadeamento. */
export interface EventoParaAnexar {
  readonly eventId: string;
  readonly type: TipoDeEvento;
  readonly occurredAt: Date;
  readonly actor: AtorDoEvento;
  readonly target: AlvoDoEvento | null;
  readonly outcome: ResultadoDeEvento;
  readonly reason: MotivoDeEvento | null;
  readonly subjectHint: string | null;
  readonly metadata: Readonly<Record<string, ValorDeMetadata>>;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

export interface ResultadoDeAnexo {
  readonly evento: EventoPersistido;
  /** Quantas voltas o compare-and-set levou. 1 = venceu de primeira. */
  readonly tentativas: number;
}

export interface FiltroDaTrilha {
  readonly type?: TipoDeEvento;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly outcome?: ResultadoDeEvento;
  readonly de?: Date;
  readonly ate?: Date;
  /** Posição a partir da qual continuar, inclusiva. */
  readonly cursor?: number;
  readonly limite: number;
}

export interface PaginaDaTrilha {
  readonly itens: readonly EventoPersistido[];
  readonly proximoCursor: number | null;
  readonly temMais: boolean;
}

interface DocAtor {
  readonly id: string | null;
  readonly type: string;
  readonly ip?: string;
  readonly user_agent?: string;
}

interface DocAlvo {
  readonly id: string;
  readonly type: string;
}

interface DocEvento {
  readonly seq: number;
  readonly event_id: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly actor: DocAtor;
  readonly target: DocAlvo | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly subject_hint: string | null;
  readonly metadata: Record<string, ValorDeMetadata>;
  readonly request_id: string | null;
  readonly trace_id: string | null;
  readonly prev_hash: string;
  readonly hash: string;
}

interface DocTopo {
  readonly _id: string;
  readonly seq: number;
  readonly hash: string;
  readonly updated_at?: Date;
}

function paraDocumento(
  base: EventoParaAnexar,
  seq: number,
  prevHash: string,
  hash: string,
): DocEvento {
  const ator: DocAtor = {
    id: base.actor.id,
    type: base.actor.type,
    ...(base.actor.ip === undefined ? {} : { ip: base.actor.ip }),
    ...(base.actor.userAgent === undefined ? {} : { user_agent: base.actor.userAgent }),
  };
  return {
    seq,
    event_id: base.eventId,
    type: base.type,
    occurred_at: base.occurredAt,
    actor: ator,
    target: base.target === null ? null : { id: base.target.id, type: base.target.type },
    outcome: base.outcome,
    reason: base.reason,
    subject_hint: base.subjectHint,
    metadata: { ...base.metadata },
    request_id: base.requestId,
    trace_id: base.traceId,
    prev_hash: prevHash,
    hash,
  };
}

function paraEntidade(doc: DocEvento): EventoPersistido {
  return {
    seq: doc.seq,
    eventId: doc.event_id,
    type: doc.type as TipoDeEvento,
    occurredAt: doc.occurred_at,
    actor: {
      id: doc.actor.id,
      type: doc.actor.type as AtorDoEvento['type'],
      ...(doc.actor.ip === undefined ? {} : { ip: doc.actor.ip }),
      ...(doc.actor.user_agent === undefined ? {} : { userAgent: doc.actor.user_agent }),
    },
    target:
      doc.target === null
        ? null
        : { id: doc.target.id, type: doc.target.type as AlvoDoEvento['type'] },
    outcome: doc.outcome as ResultadoDeEvento,
    reason: doc.reason as MotivoDeEvento | null,
    subjectHint: doc.subject_hint,
    metadata: doc.metadata,
    requestId: doc.request_id,
    traceId: doc.trace_id,
    prevHash: doc.prev_hash,
    hash: doc.hash,
  };
}

function montarFiltro(filtro: FiltroDaTrilha): Filter<DocEvento> {
  const consulta: Record<string, unknown> = {};
  if (filtro.type !== undefined) consulta['type'] = filtro.type;
  if (filtro.actorId !== undefined) consulta['actor.id'] = filtro.actorId;
  if (filtro.targetId !== undefined) consulta['target.id'] = filtro.targetId;
  if (filtro.outcome !== undefined) consulta['outcome'] = filtro.outcome;
  if (filtro.cursor !== undefined) consulta['seq'] = { $gte: filtro.cursor };

  if (filtro.de !== undefined || filtro.ate !== undefined) {
    consulta['occurred_at'] = {
      ...(filtro.de === undefined ? {} : { $gte: filtro.de }),
      ...(filtro.ate === undefined ? {} : { $lt: filtro.ate }),
    };
  }
  return consulta;
}

const CHAVE_DUPLICADA = 11_000;

function ehChaveDuplicada(erro: unknown): boolean {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { code?: unknown }).code === CHAVE_DUPLICADA
  );
}

/** Erro do teto de tentativas: contenção alta demais para a cadeia única sustentar. */
export class ErroDeContencaoDaCadeia extends Error {
  constructor(tentativas: number) {
    super(`ErroDeContencaoDaCadeia: ${String(tentativas)} tentativas sem vencer o topo`);
    this.name = 'ErroDeContencaoDaCadeia';
  }
}

export interface RepositorioDaTrilha {
  garantirGenese(): Promise<void>;
  topo(): Promise<TopoDaCadeia>;
  anexar(
    base: EventoParaAnexar,
    calcularHash: (seq: number, prevHash: string) => string,
  ): Promise<ResultadoDeAnexo>;
  buscarPorSeq(seq: number): Promise<EventoPersistido | null>;
  /** Quantos eventos de um tipo ocorreram desde um instante — contador de painel. */
  contarPorTipoDesde(tipo: string, desde: Date): Promise<number>;
  /**
   * Os eventos mais recentes em que o usuário aparece — como ator ou como alvo.
   *
   * As duas pontas importam: "o que essa pessoa fez" e "o que fizeram com ela" são a mesma
   * pergunta quando se abre a ficha de alguém.
   */
  ultimosDoUsuario(userId: string, limite: number): Promise<EventoPersistido[]>;
  listar(filtro: FiltroDaTrilha): Promise<PaginaDaTrilha>;
  lerFaixa(de: number, ate: number): AsyncIterable<EventoPersistido>;
}

export interface OpcoesDaTrilha {
  /** Teto de voltas do compare-and-set antes de desistir. */
  readonly maxTentativas: number;
}

export function criarRepositorioDaTrilha(banco: Db, opcoes: OpcoesDaTrilha): RepositorioDaTrilha {
  const trilha = banco.collection<DocEvento>(COLECAO_TRILHA);
  const topos = banco.collection<DocTopo>(COLECAO_TOPO);

  async function lerTopoOuNulo(): Promise<TopoDaCadeia | null> {
    const doc = await topos.findOne({ _id: ID_DO_TOPO });
    return doc === null ? null : { seq: doc.seq, hash: doc.hash };
  }

  async function garantirGenese(): Promise<void> {
    try {
      await topos.updateOne(
        { _id: ID_DO_TOPO },
        { $setOnInsert: { seq: 0, hash: HASH_DE_GENESE, updated_at: new Date() } },
        { upsert: true },
      );
    } catch (erro) {
      // Duas réplicas criando a gênese ao mesmo tempo: uma insere, a outra colide na chave
      // primária. O resultado desejado — o topo existe — foi alcançado pelas duas.
      if (!ehChaveDuplicada(erro)) throw erro;
    }
  }

  return {
    garantirGenese,

    async topo(): Promise<TopoDaCadeia> {
      return (await lerTopoOuNulo()) ?? { seq: 0, hash: HASH_DE_GENESE };
    },

    async anexar(base, calcularHash): Promise<ResultadoDeAnexo> {
      for (let tentativa = 1; tentativa <= opcoes.maxTentativas; tentativa += 1) {
        const anterior = await lerTopoOuNulo();
        if (anterior === null) {
          await garantirGenese();
          continue;
        }
        const seq = anterior.seq + 1;
        const hash = calcularHash(seq, anterior.hash);

        // Sem `upsert`: o casamento por `seq` é a trava. Com upsert, perder a corrida
        // tentaria inserir um segundo documento de topo e estouraria a chave primária em
        // vez de simplesmente ceder a vez.
        const venceu = await topos.findOneAndUpdate(
          { _id: ID_DO_TOPO, seq: anterior.seq },
          { $set: { seq, hash, updated_at: new Date() } },
        );
        // `null` significa que outro processo já avançou o topo entre a leitura e a
        // escrita. Reler e recalcular é obrigatório: o `prev_hash` mudou.
        if (venceu === null) continue;

        const doc = paraDocumento(base, seq, anterior.hash, hash);
        await trilha.insertOne(doc);
        return { evento: paraEntidade(doc), tentativas: tentativa };
      }
      throw new ErroDeContencaoDaCadeia(opcoes.maxTentativas);
    },

    async buscarPorSeq(seq: number): Promise<EventoPersistido | null> {
      const doc = await trilha.findOne({ seq }, { projection: { _id: 0 } });
      return doc === null ? null : paraEntidade(doc);
    },

    async contarPorTipoDesde(tipo: string, desde: Date): Promise<number> {
      return trilha.countDocuments({ type: tipo, occurred_at: { $gte: desde } });
    },

    async ultimosDoUsuario(userId: string, limite: number): Promise<EventoPersistido[]> {
      const docs = await trilha
        .find(
          { $or: [{ 'actor.id': userId }, { 'target.id': userId }] },
          { projection: { _id: 0 } },
        )
        .sort({ seq: -1 })
        .limit(limite)
        .toArray();
      return docs.map(paraEntidade);
    },

    async listar(filtro): Promise<PaginaDaTrilha> {
      // Busca um a mais que o pedido: é o jeito de saber que há próxima página sem pagar
      // um `count` sobre o filtro inteiro.
      const docs = await trilha
        .find(montarFiltro(filtro), { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .limit(filtro.limite + 1)
        .toArray();

      const temMais = docs.length > filtro.limite;
      const itens = (temMais ? docs.slice(0, filtro.limite) : docs).map(paraEntidade);
      const ultimo = itens.at(-1);

      return {
        itens,
        proximoCursor: temMais && ultimo !== undefined ? ultimo.seq + 1 : null,
        temMais,
      };
    },

    lerFaixa(de: number, ate: number): AsyncIterable<EventoPersistido> {
      const cursor = trilha
        .find({ seq: { $gte: de, $lte: ate } }, { projection: { _id: 0 } })
        .sort({ seq: 1 });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<EventoPersistido> {
          for await (const doc of cursor) yield paraEntidade(doc);
        },
      };
    },
  };
}
