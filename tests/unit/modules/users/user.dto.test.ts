/**
 * Garante que o DTO de saída nunca vaza `password_hash` e formata as datas em ISO.
 */
import { describe, expect, it } from 'vitest';
import { paraDTO } from '../../../../src/modules/users/dto/user.dto.js';
import type { Usuario } from '../../../../src/modules/users/entities/user.entity.js';

const usuario: Usuario = {
  id: '0193b6e2-1a2b-7c3d-9e4f-000000000001',
  email: 'a@iam.local',
  status: 'active',
  passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
  criadoEm: new Date('2026-07-21T01:40:00.000Z'),
  atualizadoEm: new Date('2026-07-21T02:00:00.000Z'),
};

describe('paraDTO', () => {
  it('expõe só os campos públicos, nunca o hash', () => {
    const dto = paraDTO(usuario);
    expect(dto).toEqual({
      id: usuario.id,
      email: 'a@iam.local',
      status: 'active',
      created_at: '2026-07-21T01:40:00.000Z',
      updated_at: '2026-07-21T02:00:00.000Z',
    });
    expect(Object.keys(dto)).not.toContain('passwordHash');
    expect(JSON.stringify(dto)).not.toContain('scrypt$');
  });
});
