/**
 * Responsabilidade: persistir e consumir tokens de reset de senha no MongoDB.
 * Consumido por: o PasswordService (forgot/reset) desta SPEC.
 * Regras:
 *  - Recebe o `Db` por injeção (construtor) — nunca importa singleton de conexão.
 *  - **O token em claro nunca toca o banco.** Só o `sha256(token)` é gravado e consultado.
 *  - Consumo é atômico (`findOneAndUpdate` com `used_at: null`): dois resets simultâneos
 *    com o mesmo token — só o primeiro vence.
 *  - Não conhece Fastify nem a política de senha; é só a camada de persistência.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';

const COLECAO = 'password_reset_tokens';

/** Registro consumido com sucesso — o suficiente para o serviço saber de quem é o token. */
export interface TokenDeResetConsumido {
  readonly userId: string;
}

export interface RepositorioDeTokenDeReset {
  /** Grava o `sha256` de um token novo, com validade e IP de origem para auditoria. */
  registrar(entrada: {
    token: string;
    userId: string;
    expiraEm: Date;
    ipOrigem?: string;
  }): Promise<void>;
  /**
   * Consome o token: marca `used_at` de forma atômica e devolve o dono. Devolve `null`
   * quando o token não existe, expirou ou já foi usado — sem distinguir os casos, para o
   * chamador responder um erro genérico único.
   */
  consumir(token: string): Promise<TokenDeResetConsumido | null>;
  /** Invalida todos os tokens pendentes de um usuário (troca de senha por outro caminho). */
  invalidarDoUsuario(userId: string): Promise<void>;
}

/** SHA-256 hexadecimal do token — o que persiste no lugar do token em claro. */
function digerir(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface DocumentoDeToken {
  token_sha256: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  requested_ip?: string;
}

export function criarRepositorioDeTokenDeReset(banco: Db): RepositorioDeTokenDeReset {
  const colecao = banco.collection<DocumentoDeToken>(COLECAO);

  return {
    async registrar({ token, userId, expiraEm, ipOrigem }): Promise<void> {
      await colecao.insertOne({
        token_sha256: digerir(token),
        user_id: userId,
        expires_at: expiraEm,
        used_at: null,
        ...(ipOrigem === undefined ? {} : { requested_ip: ipOrigem }),
      });
    },

    async consumir(token: string): Promise<TokenDeResetConsumido | null> {
      const agora = new Date();
      // Filtro e atualização atômicos: só casa token não usado e não expirado, e o marca
      // usado na mesma operação. O TTL apaga o expirado sozinho, mas a comparação com
      // `agora` fecha a janela entre a expiração e a varredura do TTL.
      const resultado = await colecao.findOneAndUpdate(
        { token_sha256: digerir(token), used_at: null, expires_at: { $gt: agora } },
        { $set: { used_at: agora } },
        { returnDocument: 'before' },
      );

      return resultado === null ? null : { userId: resultado.user_id };
    },

    async invalidarDoUsuario(userId: string): Promise<void> {
      // Remove em vez de marcar usado: são tokens pendentes que perderam a validade
      // porque a senha mudou; não há valor em mantê-los até o TTL.
      await colecao.deleteMany({ user_id: userId, used_at: null });
    },
  };
}
