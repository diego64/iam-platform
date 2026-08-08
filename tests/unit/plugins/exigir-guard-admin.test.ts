/**
 * Cobre a barreira de boot das rotas administrativas.
 *
 * O que se afirma aqui é que registrar uma rota desprotegida sob `/admin` **impede o processo
 * de subir**. Um teste de contrato acusaria isso no CI; esta checagem existe para a rota que
 * ninguém previu ao escrever o teste — e o único jeito de prová-la é tentar registrar a rota
 * errada e esperar a falha.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registrarExigenciaDeGuardAdmin } from '../../../src/plugins/exigir-guard-admin.js';
import {
  marcarAutenticacao,
  marcarAutorizacao,
} from '../../../src/shared/middleware/marcadores.js';

const autenticar = marcarAutenticacao(() => Promise.resolve());
const autorizar = marcarAutorizacao(() => Promise.resolve());
const semMarca = (): Promise<void> => Promise.resolve();

function appComPlugin(): FastifyInstance {
  const app = Fastify({ logger: false });
  registrarExigenciaDeGuardAdmin(app);
  return app;
}

describe('rota administrativa desprotegida', () => {
  it('recusa rota sem preHandler nenhum', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/admin/overview', () => ({}));
    }).toThrow(/autenticação e autorização/);
  });

  it('recusa rota com autenticação e sem guard', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/admin/overview', { preHandler: [autenticar] }, () => ({}));
    }).toThrow(/autorização/);
  });

  it('recusa rota com guard e sem autenticação', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/admin/overview', { preHandler: [autorizar] }, () => ({}));
    }).toThrow(/autenticação/);
  });

  it('recusa preHandler que não carrega marca nenhuma', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/admin/overview', { preHandler: [semMarca, semMarca] }, () => ({}));
    }).toThrow();
  });

  it('nomeia o método e o caminho da rota recusada', () => {
    const app = appComPlugin();

    expect(() => {
      app.delete('/admin/users/:id/sessions', () => ({}));
    }).toThrow(/DELETE \/admin\/users\/:id\/sessions/);
  });
});

describe('rota administrativa protegida', () => {
  it('aceita rota com autenticação e guard', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/admin/overview', { preHandler: [autenticar, autorizar] }, () => ({}));
    }).not.toThrow();
  });

  it('aceita preHandler único, desde que traga as duas marcas', () => {
    const app = appComPlugin();
    const combinado = marcarAutorizacao(marcarAutenticacao(() => Promise.resolve()));

    expect(() => {
      app.get('/admin/overview', { preHandler: combinado }, () => ({}));
    }).not.toThrow();
  });
});

describe('fora do prefixo administrativo', () => {
  it('ignora rota pública', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/health/live', () => ({}));
    }).not.toThrow();
  });

  it('ignora rota autenticada que não é administrativa', () => {
    const app = appComPlugin();

    expect(() => {
      app.get('/auth/me', { preHandler: [autenticar] }, () => ({}));
    }).not.toThrow();
  });
});
