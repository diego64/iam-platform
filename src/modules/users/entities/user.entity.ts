/**
 * Entidade de usuário como o domínio a enxerga — sem Fastify, sem `pg`.
 *
 * `passwordHash` mora aqui porque é coluna da linha, mas nunca sai num DTO de resposta:
 * o `user.dto.ts` monta a saída com campos nominais, e o hash fica de fora por construção.
 */
export type StatusDeUsuario = 'active' | 'blocked';

export interface Usuario {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  /** Hash corrente no formato `scrypt$...`; nunca a senha, nunca exposto na API. */
  readonly passwordHash: string;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}
