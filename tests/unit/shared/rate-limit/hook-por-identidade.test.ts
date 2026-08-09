/**
 * Cobre o hook por identidade: verifica antes, debita depois, e só quando a tentativa falha.
 * É o que impede que um usuário legítimo se auto-bloqueie usando muito o app, e o que faz um
 * erro do servidor não custar cota a quem tentou.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { criarHookDeLimitePorIdentidade } from '../../../../src/shared/rate-limit/hook-por-identidade.js';
import type { Veredito } from '../../../../src/shared/rate-limit/politica.js';

function requisicaoFake(email: string | null): FastifyRequest {
  return {
    routeOptions: { url: '/auth/login' },
    url: '/auth/login',
    body: email === null ? {} : { email },
  } as unknown as FastifyRequest;
}

function respostaFake(status: number): FastifyReply {
  return { statusCode: status } as FastifyReply;
}

function montar(veredito: Partial<Veredito> = {}): {
  hooks: ReturnType<typeof criarHookDeLimitePorIdentidade>;
  verificar: ReturnType<typeof vi.fn>;
  debitar: ReturnType<typeof vi.fn>;
  responder: ReturnType<typeof vi.fn>;
} {
  const verificar = vi.fn(() =>
    Promise.resolve<Veredito>({
      permitido: true,
      limite: 10,
      restante: 9,
      retryAfterSegundos: 0,
      ...veredito,
    }),
  );
  const debitar = vi.fn(() => Promise.resolve());
  const responder = vi.fn(() => Promise.resolve());

  return {
    hooks: criarHookDeLimitePorIdentidade({
      politica: { verificar, debitar },
      dimensao: 'conta',
      teto: 10,
      janelaMs: 60_000,
      identificar: (requisicao) => (requisicao.body as { email?: string }).email ?? null,
      responder,
    }),
    verificar,
    debitar,
    responder,
  };
}

/** Roda o par de hooks como o Fastify rodaria, com o status final dado. */
async function ciclo(
  hooks: ReturnType<typeof criarHookDeLimitePorIdentidade>,
  email: string | null,
  status: number,
): Promise<void> {
  const requisicao = requisicaoFake(email);
  await hooks.preHandler.call(undefined as never, requisicao, respostaFake(200));
  await hooks.onResponse.call(undefined as never, requisicao, respostaFake(status));
}

describe('verificar antes', () => {
  it('consulta a política com a identidade do corpo', async () => {
    const { hooks, verificar } = montar();

    await ciclo(hooks, 'admin@iam.local', 200);

    expect(verificar).toHaveBeenCalledWith(
      expect.objectContaining({ dimensao: 'conta', valor: 'admin@iam.local', teto: 10 }),
    );
  });

  it('quem já estourou é barrado', async () => {
    const { hooks, responder } = montar({ permitido: false, retryAfterSegundos: 42 });

    await ciclo(hooks, 'admin@iam.local', 429);

    expect(responder).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it('sem identidade extraível, o hook não faz nada', async () => {
    // Corpo malformado é problema da validação da rota; inventar chave aqui misturaria
    // tentativas de gente diferente no mesmo balde.
    const { hooks, verificar, debitar } = montar();

    await ciclo(hooks, null, 400);

    expect(verificar).not.toHaveBeenCalled();
    expect(debitar).not.toHaveBeenCalled();
  });
});

describe('debitar depois', () => {
  it('tentativa falha consome cota', async () => {
    const { hooks, debitar } = montar();

    await ciclo(hooks, 'admin@iam.local', 401);

    expect(debitar).toHaveBeenCalledOnce();
  });

  it('sucesso não consome cota', async () => {
    // Sem isto, quem usa muito o app se auto-bloqueia exatamente quando mais precisa.
    const { hooks, debitar } = montar();

    await ciclo(hooks, 'admin@iam.local', 200);

    expect(debitar).not.toHaveBeenCalled();
  });

  it('erro do servidor não consome cota', async () => {
    // O usuário não paga por falha nossa.
    const { hooks, debitar } = montar();

    await ciclo(hooks, 'admin@iam.local', 500);

    expect(debitar).not.toHaveBeenCalled();
  });

  it('400 de validação consome cota', async () => {
    const { hooks, debitar } = montar();

    await ciclo(hooks, 'admin@iam.local', 400);

    expect(debitar).toHaveBeenCalledOnce();
  });
});
