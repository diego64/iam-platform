/**
 * DTO de saída do usuário — a forma explícita que a API expõe.
 *
 * `password_hash` fica de fora por construção: a resposta é montada campo a campo, então o
 * hash não vaza por serialização automática e um campo novo na entidade não aparece
 * sozinho no corpo (defesa contra mass-assignment/vazamento).
 */
import type { StatusDeUsuario, Usuario } from '../entities/user.entity.js';

export interface UsuarioDTO {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  readonly created_at: string;
  readonly updated_at: string;
}

export function paraDTO(usuario: Usuario): UsuarioDTO {
  return {
    id: usuario.id,
    email: usuario.email,
    status: usuario.status,
    created_at: usuario.criadoEm.toISOString(),
    updated_at: usuario.atualizadoEm.toISOString(),
  };
}
