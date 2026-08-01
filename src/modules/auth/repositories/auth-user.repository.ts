/**
 * Responsabilidade: leitura em PostgreSQL do que o login precisa — o usuário por e-mail
 * (com hash e status) e os papéis para os claims do token.
 * Consumido por: o `AuthService`.
 * Regras:
 *  - Recebe o `Pool` por injeção; SQL parametrizado; colunas nominais.
 *  - Só leitura: a escrita de usuários/papéis pertence às SPECs 002/003.
 */
import type { Pool } from 'pg';
import type { StatusDeUsuario } from '../../users/entities/user.entity.js';

export interface UsuarioParaLogin {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  /** Hash `scrypt$...`; usado só para verificar a senha, nunca exposto. */
  readonly passwordHash: string;
}

/** Perfil do usuário para `/auth/me` — sem hash. */
export interface UsuarioParaPerfil {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
}

export interface RepositorioDeAutenticacao {
  buscarPorEmail(email: string): Promise<UsuarioParaLogin | null>;
  buscarPorId(id: string): Promise<UsuarioParaPerfil | null>;
  papeisDoUsuario(userId: string): Promise<string[]>;
}

interface LinhaDeLogin {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  readonly password_hash: string;
}

export function criarRepositorioDeAutenticacao(pool: Pool): RepositorioDeAutenticacao {
  return {
    async buscarPorEmail(email: string): Promise<UsuarioParaLogin | null> {
      const { rows } = await pool.query<LinhaDeLogin>(
        'SELECT id, email, status, password_hash FROM users WHERE email = $1',
        [email],
      );
      const linha = rows[0];
      return linha === undefined
        ? null
        : {
            id: linha.id,
            email: linha.email,
            status: linha.status,
            passwordHash: linha.password_hash,
          };
    },

    async buscarPorId(id: string): Promise<UsuarioParaPerfil | null> {
      const { rows } = await pool.query<{ id: string; email: string; status: StatusDeUsuario }>(
        'SELECT id, email, status FROM users WHERE id = $1',
        [id],
      );
      const linha = rows[0];
      return linha === undefined
        ? null
        : { id: linha.id, email: linha.email, status: linha.status };
    },

    async papeisDoUsuario(userId: string): Promise<string[]> {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT r.name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1
          ORDER BY r.name`,
        [userId],
      );
      return rows.map((linha) => linha.name);
    },
  };
}
