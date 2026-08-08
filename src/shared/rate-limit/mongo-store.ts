/**
 * Responsabilidade: contador de rate limit compartilhado, no MongoDB.
 * Consumido por: a política de limite, em produção.
 * Regras:
 *  - Recebe o `Db` por injeção. O TTL index é de `indexes.ts`.
 *  - A chave é o próprio `_id`: o `upsert` fica atômico e não há índice a manter além do
 *    que o Mongo já cria. Duas requisições simultâneas na mesma chave contam 2, não 1.
 *  - Janela fixa. `$setOnInsert` grava o fim da janela só na criação, então o incremento
 *    seguinte não estende a janela — o que transformaria o teto num limite deslizante que
 *    nunca vence enquanto houver tráfego.
 *  - **Falha de I/O devolve `null`, nunca lança.** Quem chama trata `null` como "não sei" e
 *    deixa passar. É a decisão de fail open desta SPEC, e ela mora aqui para que nenhum
 *    chamador precise lembrar de envolver a chamada num try.
 *  - Timeout próprio: sem ele, um Mongo lento não derruba o login, mas o segura — que na
 *    prática é o mesmo que derrubar.
 */
import type { Db } from 'mongodb';
import type { ContadorDeRateLimit, EstadoDaJanela } from './types.js';

const COLECAO = 'rate_limit_counters';

export interface OpcoesDoContadorNoMongo {
  readonly banco: Db;
  /** Acima disso, a operação é abandonada e a requisição segue. */
  readonly timeoutMs: number;
  /** Chamado quando o contador falha — alimenta métrica e log. */
  readonly aoFalhar?: (erro: unknown) => void;
}

interface LinhaMongo {
  readonly _id: string;
  readonly count: number;
  readonly expires_at: Date;
}

export function criarContadorNoMongo(opcoes: OpcoesDoContadorNoMongo): ContadorDeRateLimit {
  const colecao = opcoes.banco.collection<LinhaMongo>(COLECAO);

  function falhou(erro: unknown): null {
    opcoes.aoFalhar?.(erro);
    return null;
  }

  return {
    async incrementar(chave: string, janelaMs: number): Promise<EstadoDaJanela | null> {
      try {
        const linha = await colecao.findOneAndUpdate(
          { _id: chave },
          {
            $inc: { count: 1 },
            // Só na criação: o incremento não pode empurrar o fim da janela para frente.
            $setOnInsert: { expires_at: new Date(Date.now() + janelaMs) },
          },
          { upsert: true, returnDocument: 'after', maxTimeMS: opcoes.timeoutMs },
        );
        if (linha === null) return falhou(new Error('contador sem documento após upsert'));
        return { contagem: linha.count, expiraEm: linha.expires_at };
      } catch (erro) {
        return falhou(erro);
      }
    },

    async ler(chave: string): Promise<EstadoDaJanela | null> {
      try {
        const linha = await colecao.findOne({ _id: chave }, { maxTimeMS: opcoes.timeoutMs });
        // Ausência é contagem zero — resposta válida, diferente de não conseguir responder.
        return linha === null
          ? { contagem: 0, expiraEm: new Date() }
          : { contagem: linha.count, expiraEm: linha.expires_at };
      } catch (erro) {
        return falhou(erro);
      }
    },
  };
}
