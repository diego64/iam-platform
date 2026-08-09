/**
 * Responsabilidade: persistir e ler os eventos de segurança no MongoDB.
 * Consumido por: o detector (escrita) e o serviço de consulta (leitura).
 * Regras:
 *  - Recebe o `Db` por injeção. Índices são de `indexes.ts`.
 *  - Coleção própria, **separada da trilha**: a trilha guarda fatos, é encadeada por hash e
 *    não expira; isto aqui é juízo derivado, revisável, e tem validade. Misturar os dois
 *    contaminaria a cadeia de integridade com registros reprocessáveis.
 *  - Só escreve por inserção. Não existe método que atualize ou remova um evento: a
 *    retenção é o TTL, e apagar por código daria a quem invadisse a ferramenta para varrer
 *    o próprio rastro.
 *  - A leitura exige recorte por tempo. Sem ele, a consulta varreria a coleção inteira e o
 *    custo apareceria no dia de maior volume — que é justamente o dia do ataque.
 */
import type { Db, Filter } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Regra, Severidade, TipoDeSujeito } from '../constants/regras.js';
import type { Deteccao, EventoDeSeguranca } from '../types/security-event.js';

const COLECAO = 'security_events';

export interface EntradaDeEvento extends Deteccao {
  readonly primeiraEm: Date;
  readonly ultimaEm: Date;
  readonly traceId: string | null;
  readonly expiraEm: Date;
}

export interface FiltroDeEventos {
  readonly regra?: Regra;
  readonly severidade?: Severidade;
  readonly pista?: string;
  readonly desde: Date;
  readonly ate: Date;
  readonly limite: number;
  /** `_id` do último item da página anterior. */
  readonly cursor?: string;
}

export interface PaginaDeEventos {
  readonly itens: readonly EventoDeSeguranca[];
  readonly proximoCursor: string | null;
}

export interface RepositorioDeEventosDeSeguranca {
  anexar(entrada: EntradaDeEvento): Promise<EventoDeSeguranca>;
  listar(filtro: FiltroDeEventos): Promise<PaginaDeEventos>;
  buscarPorId(id: string): Promise<EventoDeSeguranca | null>;
}

interface LinhaMongo {
  readonly _id: ObjectId;
  readonly regra: Regra;
  readonly severidade: Severidade;
  readonly sujeito: { readonly tipo: TipoDeSujeito; readonly pista: string };
  readonly ocorrencias: number;
  readonly janela_ms: number;
  readonly primeira_em: Date;
  readonly ultima_em: Date;
  readonly detectado_em: Date;
  readonly trace_id: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly expires_at: Date;
}

function paraDominio(linha: LinhaMongo): EventoDeSeguranca {
  return {
    id: linha._id.toHexString(),
    regra: linha.regra,
    severidade: linha.severidade,
    sujeito: linha.sujeito,
    ocorrencias: linha.ocorrencias,
    janelaMs: linha.janela_ms,
    primeiraEm: linha.primeira_em,
    ultimaEm: linha.ultima_em,
    detectadoEm: linha.detectado_em,
    traceId: linha.trace_id,
    metadata: linha.metadata,
  };
}

export function criarRepositorioDeEventosDeSeguranca(banco: Db): RepositorioDeEventosDeSeguranca {
  const colecao = banco.collection<LinhaMongo>(COLECAO);

  return {
    async anexar(entrada: EntradaDeEvento): Promise<EventoDeSeguranca> {
      const detectadoEm = new Date();
      const documento = {
        _id: new ObjectId(),
        regra: entrada.regra,
        severidade: entrada.severidade,
        sujeito: entrada.sujeito,
        ocorrencias: entrada.ocorrencias,
        janela_ms: entrada.janelaMs,
        primeira_em: entrada.primeiraEm,
        ultima_em: entrada.ultimaEm,
        detectado_em: detectadoEm,
        trace_id: entrada.traceId,
        metadata: entrada.metadata,
        expires_at: entrada.expiraEm,
      };
      await colecao.insertOne(documento);
      return paraDominio(documento);
    },

    async listar(filtro: FiltroDeEventos): Promise<PaginaDeEventos> {
      const consulta: Filter<LinhaMongo> = {
        detectado_em: { $gte: filtro.desde, $lte: filtro.ate },
        ...(filtro.regra === undefined ? {} : { regra: filtro.regra }),
        ...(filtro.severidade === undefined ? {} : { severidade: filtro.severidade }),
        ...(filtro.pista === undefined ? {} : { 'sujeito.pista': filtro.pista }),
        // Paginação por `_id`: ele é monotônico no tempo e único, então não perde nem
        // repete item quando dois eventos caem no mesmo milissegundo.
        ...(filtro.cursor === undefined ? {} : { _id: { $lt: new ObjectId(filtro.cursor) } }),
      };

      const linhas = await colecao
        .find(consulta)
        .sort({ _id: -1 })
        .limit(filtro.limite + 1)
        .toArray();

      const temMais = linhas.length > filtro.limite;
      const pagina = temMais ? linhas.slice(0, filtro.limite) : linhas;

      return {
        itens: pagina.map(paraDominio),
        proximoCursor: temMais ? (pagina[pagina.length - 1]?._id.toHexString() ?? null) : null,
      };
    },

    async buscarPorId(id: string): Promise<EventoDeSeguranca | null> {
      if (!ObjectId.isValid(id)) return null;
      const linha = await colecao.findOne({ _id: new ObjectId(id) });
      return linha === null ? null : paraDominio(linha);
    },
  };
}
