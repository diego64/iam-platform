/**
 * Cobre os schemas Zod da borda: strict contra campo extra, política na senha, trim do
 * e-mail, defaults/coerção da query e validação de uuid nos params.
 */
import { describe, expect, it } from 'vitest';
import {
  atualizarUsuarioBody,
  criarUsuarioBody,
  idParams,
  listarUsuariosQuery,
} from '../../../../src/modules/users/schemas/user.schema.js';

const SENHA = 'S3nh@MuitoForte!';

describe('criarUsuarioBody', () => {
  it('aceita e-mail + senha forte e faz trim do e-mail', () => {
    const r = criarUsuarioBody.parse({ email: '  a@iam.local ', senha: SENHA });
    expect(r.email).toBe('a@iam.local');
  });

  it('rejeita campo extra (anti mass-assignment)', () => {
    expect(() =>
      criarUsuarioBody.parse({ email: 'a@iam.local', senha: SENHA, status: 'blocked' }),
    ).toThrow();
  });

  it('rejeita senha fraca', () => {
    expect(() => criarUsuarioBody.parse({ email: 'a@iam.local', senha: 'fraca' })).toThrow();
  });

  it('rejeita e-mail inválido', () => {
    expect(() => criarUsuarioBody.parse({ email: 'nao-email', senha: SENHA })).toThrow();
  });
});

describe('atualizarUsuarioBody', () => {
  it('aceita só e-mail; campo extra ⇒ erro', () => {
    expect(atualizarUsuarioBody.parse({ email: 'b@iam.local' }).email).toBe('b@iam.local');
    expect(() => atualizarUsuarioBody.parse({ email: 'b@iam.local', senha: SENHA })).toThrow();
  });
});

describe('idParams', () => {
  it('exige uuid', () => {
    expect(idParams.parse({ id: '0193b6e2-1a2b-4c3d-9e4f-000000000001' }).id).toBeDefined();
    expect(() => idParams.parse({ id: '42' })).toThrow();
  });
});

describe('listarUsuariosQuery', () => {
  it('aplica defaults e coage números', () => {
    const r = listarUsuariosQuery.parse({});
    expect(r).toEqual({ limit: 20, offset: 0 });
  });

  it('respeita o teto de 100 no limit', () => {
    expect(() => listarUsuariosQuery.parse({ limit: '500' })).toThrow();
  });

  it('aceita filtro de status válido e rejeita inválido', () => {
    expect(listarUsuariosQuery.parse({ status: 'blocked' }).status).toBe('blocked');
    expect(() => listarUsuariosQuery.parse({ status: 'zumbi' })).toThrow();
  });
});
