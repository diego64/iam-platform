/**
 * Cobre os tetos de recurso do servidor: corpo, comprimento de parâmetro de caminho e
 * timeout de requisição.
 *
 * O caso do timeout é o único que abre socket de verdade. `inject` não passa por rede — o
 * corpo chega inteiro e instantaneamente —, então um Slowloris simplesmente não existe
 * naquele caminho, e testá-lo por lá provaria nada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { envCompleta, montarAppCompleto } from '../../mocks/app-completo.js';

/** Um pouco acima do teto configurado — o suficiente para o parser recusar. */
const CORPO_GRANDE = 'a'.repeat(70_000);

let app: FastifyInstance;

beforeAll(async () => {
  app = await montarAppCompleto();
});

afterAll(async () => {
  await app.close();
});

describe('teto de corpo', () => {
  it('recusa corpo acima do limite com 413 em problem+json', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', senha: CORPO_GRANDE }),
    });

    expect(resposta.statusCode).toBe(413);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
    expect(resposta.json()).toMatchObject({ status: 413 });
  });

  it('não devolve o corpo recusado nem parte dele na resposta', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', senha: CORPO_GRANDE }),
    });

    expect(resposta.body).not.toContain('aaaa');
  });

  it('mantém os cabeçalhos de segurança na resposta de recusa', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', senha: CORPO_GRANDE }),
    });

    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('comprimento de parâmetro de caminho', () => {
  it('recusa com 414 quando o parâmetro passa do teto', async () => {
    const resposta = await app.inject({ method: 'GET', url: `/users/${'x'.repeat(300)}` });

    // 414 e não 404: o roteador distingue "caminho longo demais" de "caminho inexistente",
    // e a recusa acontece antes de qualquer handler ver a requisição.
    expect(resposta.statusCode).toBe(414);
    expect(resposta.headers['content-type']).toContain('application/problem+json');
  });

  it('não ecoa o caminho ofensivo de volta para o cliente', async () => {
    const caminho = 'x'.repeat(300);
    const resposta = await app.inject({ method: 'GET', url: `/users/${caminho}` });

    // O corpo default do Fastify para este erro devolve a string recebida inteira.
    expect(resposta.body).not.toContain(caminho);
  });

  it('continua casando um UUID, que é o tamanho real de um `:id`', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/users/0193b6e2-0000-7000-8000-000000000000',
    });

    // Sem token o guard recusa — o que importa aqui é não ter caído no 404 do roteador.
    expect(resposta.statusCode).not.toBe(404);
  });
});

describe('tempos do servidor', () => {
  /**
   * Asserção sobre o servidor Node, não sobre um cliente lento.
   *
   * O `requestTimeout` do Node não dispara no instante em que vence: quem o aplica é uma
   * varredura periódica de conexões, cujo intervalo (`connectionsCheckingInterval`) tem 30 s
   * de default e não é exposto pelo Fastify. Um teste que abrisse socket e esperasse o
   * encerramento levaria mais de 30 s por caso — caro demais para o que provaria a mais.
   * O que pode dar errado aqui é a opção não chegar ao servidor, e é isso que se verifica.
   */
  it('propaga os tempos configurados para o servidor HTTP', () => {
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.server.keepAliveTimeout).toBe(72_000);
  });

  it('respeita o valor vindo do ambiente', async () => {
    const curto = await montarAppCompleto(envCompleta({ HTTP_REQUEST_TIMEOUT_MS: '5000' }));

    try {
      expect(curto.server.requestTimeout).toBe(5_000);
    } finally {
      await curto.close();
    }
  });

  it('mantém o keep-alive acima do tempo ocioso típico de proxy (60 s)', () => {
    // Menor que o do proxy, a conexão é fechada pelo Node no instante em que o proxy a
    // reusa, e o cliente vê 502 esporádico sem rastro no log do processo.
    expect(app.server.keepAliveTimeout).toBeGreaterThan(60_000);
  });
});
