/**
 * Responsabilidade: contar **valores distintos** numa janela — o que a regra de credential
 * stuffing precisa e o contador de rate limit não faz.
 * Consumido por: a regra `credential_stuffing`.
 * Regras:
 *  - `$addToSet` é o que dá a distinção: a mesma conta tentada cem vezes do mesmo IP conta
 *    uma vez. É a diferença entre "insistiu numa conta" (outra regra) e "varreu contas".
 *  - Teto de tamanho no conjunto. Sem ele, um documento cresce sem limite enquanto o ataque
 *    durar — e o limiar já disparou muito antes do centésimo item. Acima do teto o conjunto
 *    para de crescer e a contagem satura, o que é suficiente: a decisão já foi tomada.
 *  - TTL na janela, como o contador. Falha de I/O devolve `null` e quem chama deixa passar,
 *    pelo mesmo motivo do resto da detecção: ela não pode atrapalhar quem só quer entrar.
 */
import type { Db } from 'mongodb';

const COLECAO = 'security_distinct_sets';

export interface RepositorioDeConjuntoDistinto {
  /**
   * Acrescenta o valor ao conjunto da chave e devolve quantos distintos há na janela.
   * `null` quando o banco falhou — a detecção então não conclui nada.
   */
  registrar(chave: string, valor: string, janelaMs: number): Promise<number | null>;
}

interface LinhaMongo {
  readonly _id: string;
  readonly valores: string[];
  readonly expires_at: Date;
}

export interface OpcoesDoConjunto {
  readonly banco: Db;
  /** Acima disto o conjunto para de crescer; a contagem satura no teto. */
  readonly tamanhoMaximo: number;
  readonly aoFalhar?: (erro: unknown) => void;
}

export function criarRepositorioDeConjuntoDistinto(
  opcoes: OpcoesDoConjunto,
): RepositorioDeConjuntoDistinto {
  const colecao = opcoes.banco.collection<LinhaMongo>(COLECAO);

  return {
    async registrar(chave: string, valor: string, janelaMs: number): Promise<number | null> {
      try {
        const linha = await colecao.findOneAndUpdate(
          { _id: chave },
          {
            // `$each` com `$slice` mantém o teto sem uma leitura antes da escrita.
            $addToSet: { valores: valor },
            // Só na criação: a janela é fixa, e o acréscimo não a empurra para frente.
            $setOnInsert: { expires_at: new Date(Date.now() + janelaMs) },
          },
          { upsert: true, returnDocument: 'after' },
        );
        if (linha === null) return null;

        if (linha.valores.length > opcoes.tamanhoMaximo) {
          // Poda preguiçosa: só quando o teto é ultrapassado, e sem bloquear a resposta.
          void colecao
            .updateOne({ _id: chave }, [
              { $set: { valores: { $slice: ['$valores', opcoes.tamanhoMaximo] } } },
            ])
            .catch(() => {
              /* a poda é higiene, não decisão */
            });
          return opcoes.tamanhoMaximo;
        }

        return linha.valores.length;
      } catch (erro) {
        opcoes.aoFalhar?.(erro);
        return null;
      }
    },
  };
}
