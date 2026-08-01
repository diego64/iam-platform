/**
 * Responsabilidade: limite de taxa das rotas de sessão, por conta.
 * Consumido por: `routes/` (via `config.rateLimit`) e o registro do `@fastify/rate-limit`.
 * Regras:
 *  - A chave é a conta (`sub` do token), não o IP: são rotas autenticadas, e o alvo do limite é
 *    a conta, não a origem de rede. O `sub` é lido do token sem verificar assinatura — a chave
 *    de balde não é controle de segurança; no pior caso um token forjado só compartilha balde.
 *  - Token ilegível cai para o IP, para nunca ficar sem chave.
 */
import type { FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';

/** Chave do balde de rate limit: a conta do token, ou o IP quando o token não é legível. */
export function chaveDeConta(requisicao: FastifyRequest): string {
  const cabecalho = requisicao.headers.authorization;
  if (cabecalho?.startsWith('Bearer ')) {
    try {
      const { sub } = decodeJwt(cabecalho.slice(7));
      if (typeof sub === 'string' && sub !== '') return `conta:${sub}`;
    } catch {
      /* token ilegível: cai para o IP */
    }
  }
  return `ip:${requisicao.ip}`;
}

export interface ConfigDeRotaComChave {
  readonly max: number;
  readonly timeWindow: string;
  readonly keyGenerator: (requisicao: FastifyRequest) => string;
}

export const LIMITE_SESSOES: ConfigDeRotaComChave = {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: chaveDeConta,
};
