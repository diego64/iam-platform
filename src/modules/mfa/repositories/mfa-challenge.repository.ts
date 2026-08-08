/**
 * Responsabilidade: guardar o desafio de MFA — o estado do login que parou entre a senha e o
 * segundo fator — no MongoDB, com TTL.
 * Consumido por: o serviço de desafio de MFA.
 * Regras:
 *  - Recebe o `Db` por injeção. Índices (unique `token_hash`, TTL em `expires_at`) são de
 *    `indexes.ts`.
 *  - Só o `sha256` do token opaco é gravado; o token em claro nunca toca o banco.
 *  - `consumir` é `findOneAndDelete`: atômico, então dois pedidos com o mesmo desafio
 *    produzem no máximo um par de tokens.
 *  - `registrarFalha` devolve quantas tentativas já houve, para quem chama decidir se
 *    destrói o desafio. Contar do lado de fora obrigaria a ler antes de escrever, e duas
 *    tentativas simultâneas contariam como uma.
 */
import type { Db } from 'mongodb';

const COLECAO = 'mfa_challenges';

export interface DesafioDeMfa {
  readonly userId: string;
  readonly tentativas: number;
}

export interface RepositorioDeDesafioDeMfa {
  criar(entrada: { tokenHash: string; userId: string; expiraEm: Date }): Promise<void>;
  buscar(tokenHash: string): Promise<DesafioDeMfa | null>;
  /** Remove e devolve o desafio; `null` se outro pedido já o consumiu. */
  consumir(tokenHash: string): Promise<DesafioDeMfa | null>;
  /** Incrementa o contador e devolve o total já acumulado. */
  registrarFalha(tokenHash: string): Promise<number>;
  remover(tokenHash: string): Promise<void>;
  /** Descarta os desafios abertos de um usuário (troca de senha, reset de fator). */
  removerDoUsuario(userId: string): Promise<void>;
}

interface LinhaMongo {
  readonly token_hash: string;
  readonly user_id: string;
  readonly attempts: number;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export function criarRepositorioDeDesafioDeMfa(banco: Db): RepositorioDeDesafioDeMfa {
  const colecao = banco.collection<LinhaMongo>(COLECAO);

  return {
    async criar(entrada): Promise<void> {
      await colecao.insertOne({
        token_hash: entrada.tokenHash,
        user_id: entrada.userId,
        attempts: 0,
        created_at: new Date(),
        expires_at: entrada.expiraEm,
      });
    },

    async buscar(tokenHash): Promise<DesafioDeMfa | null> {
      const linha = await colecao.findOne({ token_hash: tokenHash });
      return linha === null ? null : { userId: linha.user_id, tentativas: linha.attempts };
    },

    async consumir(tokenHash): Promise<DesafioDeMfa | null> {
      const linha = await colecao.findOneAndDelete({ token_hash: tokenHash });
      return linha === null ? null : { userId: linha.user_id, tentativas: linha.attempts };
    },

    async registrarFalha(tokenHash): Promise<number> {
      const linha = await colecao.findOneAndUpdate(
        { token_hash: tokenHash },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      );
      return linha?.attempts ?? 0;
    },

    async remover(tokenHash): Promise<void> {
      await colecao.deleteOne({ token_hash: tokenHash });
    },

    async removerDoUsuario(userId): Promise<void> {
      await colecao.deleteMany({ user_id: userId });
    },
  };
}
