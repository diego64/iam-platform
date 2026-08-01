/**
 * Responsabilidade: a projeção pública de uma sessão — o que o dono vê na listagem.
 * Regras: sem `_id` nem `user_id` (o dono já é o autenticado); datas em ISO 8601; `current`
 * calculado na borda comparando com a sessão do token corrente.
 */
import type { SessaoAtiva } from '../repositories/session.repository.js';

export interface SessaoDTO {
  readonly id: string;
  readonly current: boolean;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
  readonly last_seen_at: string;
}

/** Monta o DTO, marcando como atual a sessão cujo id casa com o `sid` do token. */
export function paraSessaoDTO(sessao: SessaoAtiva, sidAtual: string | undefined): SessaoDTO {
  return {
    id: sessao.sessionId,
    current: sessao.sessionId === sidAtual,
    ip: sessao.ip,
    user_agent: sessao.userAgent,
    created_at: sessao.createdAt.toISOString(),
    last_seen_at: sessao.lastSeenAt.toISOString(),
  };
}
