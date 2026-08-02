/**
 * Cobre o guard de autorização: casamento exato, curinga `*` e `recurso:*`, fail closed
 * (permissions ausente/não-array ⇒ 403) e `exigirPapel` (base da restrição RF-09).
 * Usa um app Fastify mínimo com um preHandler que injeta `request.usuario` antes do guard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  criarGuardsDeAutorizacao,
  satisfaz,
} from '../../../../src/modules/rbac/middleware/require-permission.js';
import type { UsuarioAutenticado } from '../../../../src/modules/auth/types/auth.types.js';

let app: FastifyInstance;
/** Usuário injetado na requisição; `null` simula rota sem autenticação prévia. */
let usuarioAtual: UsuarioAutenticado | null;

function montar(guardFactory: (g: ReturnType<typeof criarGuardsDeAutorizacao>) => unknown): void {
  const guards = criarGuardsDeAutorizacao();
  app = Fastify({ logger: false });
  app.get(
    '/protegido',
    {
      preHandler: [
        (requisicao, _resposta, done) => {
          if (usuarioAtual !== null) requisicao.usuario = usuarioAtual;
          done();
        },
        guardFactory(guards) as never,
      ],
    },
    () => ({ ok: true }),
  );
}

function usuario(permissions: string[], roles: string[] = []): UsuarioAutenticado {
  return { id: 'u1', roles, permissions, scope: '' };
}

beforeEach(() => {
  usuarioAtual = null;
});

afterEach(async () => {
  // O teste puro de `satisfaz` não monta app; só fecha quem existe.
  if (app as FastifyInstance | undefined) await app.close();
});

describe('satisfaz', () => {
  it('exato, curinga de recurso e curinga global', () => {
    expect(satisfaz('roles:write', ['roles:write'])).toBe(true);
    expect(satisfaz('roles:write', ['roles:*'])).toBe(true);
    expect(satisfaz('roles:write', ['*'])).toBe(true);
    expect(satisfaz('roles:write', ['roles:read'])).toBe(false);
    expect(satisfaz('roles:write', [])).toBe(false);
  });
});

describe('exigirPermissao', () => {
  it('permite quando a permissão exata está presente', async () => {
    usuarioAtual = usuario(['roles:write']);
    montar((g) => g.exigirPermissao('roles:write'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(200);
  });

  it('permite via curinga global `*`', async () => {
    usuarioAtual = usuario(['*']);
    montar((g) => g.exigirPermissao('permissions:delete'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(200);
  });

  it('nega (403) quando falta a permissão', async () => {
    usuarioAtual = usuario(['roles:read']);
    montar((g) => g.exigirPermissao('roles:write'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('authorization-denied');
  });

  it('fail closed: sem usuario autenticado ⇒ 403, nunca 500', async () => {
    usuarioAtual = null;
    montar((g) => g.exigirPermissao('roles:write'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(403);
  });

  it('fail closed: permissions não-array ⇒ 403', async () => {
    // Token adulterado que passasse pela verificação traria `perm` malformado; o guard
    // não pode confiar no formato. Cast deliberado para exercitar essa borda.
    usuarioAtual = {
      id: 'u1',
      roles: [],
      scope: '',
      permissions: 'x',
    } as unknown as UsuarioAutenticado;
    montar((g) => g.exigirPermissao('roles:write'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(403);
  });
});

describe('exigirPapel', () => {
  it('permite quando o usuário tem o papel', async () => {
    usuarioAtual = usuario([], ['superadmin']);
    montar((g) => g.exigirPapel('superadmin'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(200);
  });

  it('nega (403) quando o usuário não tem o papel exigido', async () => {
    usuarioAtual = usuario([], ['editor']);
    montar((g) => g.exigirPapel('superadmin'));
    const res = await app.inject({ method: 'GET', url: '/protegido' });
    expect(res.statusCode).toBe(403);
  });
});
