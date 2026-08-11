/**
 * Cobre o canal de divulgação de vulnerabilidade publicado na superfície HTTP.
 *
 * O caso da validade é o que importa: a RFC exige o campo e recusa data no passado, e um
 * arquivo com data escrita à mão expira sozinho — sem erro, sem alerta, e justamente para
 * o scanner que iria lê-lo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../../src/app.js';
import { carregarEnv } from '../../../src/config/env.js';
import { montarSecurityTxt } from '../../../src/modules/health/routes/security-txt.routes.js';

const CAMINHO = '/.well-known/security.txt';

let app: FastifyInstance;

beforeAll(async () => {
  app = await construirApp(
    carregarEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      POSTGRES_URL: 'postgres://ninguem@127.0.0.1:1/inexistente',
      MONGODB_URL: 'mongodb://127.0.0.1:1',
    }),
  );
});

afterAll(async () => {
  await app.close();
});

describe('resposta', () => {
  it('responde 200 em texto puro', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.headers['content-type']).toContain('text/plain');
  });

  it('traz contato e política', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });

    expect(resposta.body).toContain('Contact: https://');
    expect(resposta.body).toContain('Policy: https://');
    expect(resposta.body).toContain('Preferred-Languages:');
  });

  it('não exige credencial — quem encontra a falha não tem uma', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });

    expect(resposta.statusCode).not.toBe(401);
  });

  it('é cacheável por um dia, como conteúdo público e estável', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });

    expect(resposta.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('mantém os cabeçalhos de segurança', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });

    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    expect(resposta.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('validade', () => {
  it('a data de expiração está no futuro', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });
    const linha = resposta.body.split('\n').find((l) => l.startsWith('Expires:'));

    expect(linha).toBeDefined();
    const validade = new Date((linha ?? '').replace('Expires:', '').trim());
    expect(validade.getTime()).toBeGreaterThan(Date.now());
  });

  it('a validade acompanha o momento da resposta, e não uma data fixa', () => {
    const emJaneiro = montarSecurityTxt(new Date('2030-01-01T00:00:00.000Z'));
    const emJulho = montarSecurityTxt(new Date('2030-07-01T00:00:00.000Z'));

    expect(emJaneiro).not.toBe(emJulho);
    expect(emJaneiro).toContain('Expires: 2031-01-01');
  });

  it('não passa de um ano, que é o teto do formato', async () => {
    const resposta = await app.inject({ method: 'GET', url: CAMINHO });
    const linha = resposta.body.split('\n').find((l) => l.startsWith('Expires:')) ?? '';
    const validade = new Date(linha.replace('Expires:', '').trim());

    const umAno = 366 * 24 * 60 * 60 * 1000;
    expect(validade.getTime() - Date.now()).toBeLessThanOrEqual(umAno);
  });
});
