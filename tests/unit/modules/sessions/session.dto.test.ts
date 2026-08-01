/**
 * Cobre a projeção pública da sessão: marca `current` pela sessão do token, expõe datas em
 * ISO e não vaza `user_id` nem `_id`.
 */
import { describe, expect, it } from 'vitest';
import { paraSessaoDTO } from '../../../../src/modules/sessions/dto/session.dto.js';
import type { SessaoAtiva } from '../../../../src/modules/sessions/repositories/session.repository.js';

const SESSAO: SessaoAtiva = {
  sessionId: 'sess-1',
  ip: '203.0.113.5',
  userAgent: 'Mozilla/5.0',
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  lastSeenAt: new Date('2026-08-01T13:00:00.000Z'),
};

describe('paraSessaoDTO', () => {
  it('marca current quando o id casa com o sid do token', () => {
    expect(paraSessaoDTO(SESSAO, 'sess-1').current).toBe(true);
    expect(paraSessaoDTO(SESSAO, 'outra').current).toBe(false);
    expect(paraSessaoDTO(SESSAO, undefined).current).toBe(false);
  });

  it('projeta datas em ISO e não inclui user_id/_id', () => {
    const dto = paraSessaoDTO(SESSAO, 'sess-1');
    expect(dto).toEqual({
      id: 'sess-1',
      current: true,
      ip: '203.0.113.5',
      user_agent: 'Mozilla/5.0',
      created_at: '2026-08-01T12:00:00.000Z',
      last_seen_at: '2026-08-01T13:00:00.000Z',
    });
  });
});
