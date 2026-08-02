/**
 * O PEP é o ponto onde uma decisão vira status HTTP. Os casos de falha importam mais que o
 * feliz: carregador que estoura, motor que estoura e usuário ausente têm de virar 403, nunca
 * 500 e nunca passagem. E recurso inexistente tem de virar 404 antes da política, senão o
 * par (403, 404) revela a existência do recurso a quem não pode vê-lo.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  criarGuardsDePolitica,
  type GuardDePolitica,
} from '../../../../src/modules/abac/middleware/require-policy.js';
import type { ContextoDeDecisao, Decisao } from '../../../../src/modules/abac/types/abac.types.js';

interface RespostaEspiada {
  resposta: FastifyReply;
  status: () => number | undefined;
  corpo: () => Record<string, unknown> | undefined;
}

function respostaEspiada(): RespostaEspiada {
  let statusRecebido: number | undefined;
  let corpoRecebido: Record<string, unknown> | undefined;
  const resposta = {
    status(codigo: number) {
      statusRecebido = codigo;
      return this;
    },
    type() {
      return this;
    },
    send(corpo: Record<string, unknown>) {
      corpoRecebido = corpo;
      return Promise.resolve();
    },
  } as unknown as FastifyReply;
  return { resposta, status: () => statusRecebido, corpo: () => corpoRecebido };
}

function requisicao(comUsuario = true): FastifyRequest {
  return {
    ip: '10.0.0.9',
    params: { id: 'r-1' },
    ...(comUsuario
      ? { usuario: { id: 'u-1', roles: ['operator'], permissions: ['users:read'], scope: '' } }
      : {}),
  } as unknown as FastifyRequest;
}

interface GuardMontado {
  guard: GuardDePolitica;
  avaliar: Mock;
  carregar: Mock;
  registrarDecisao: Mock;
}

function guardCom(
  decisao: Decisao | Error,
  recurso: Record<string, string> | null | Error,
): GuardMontado {
  const avaliar = vi.fn(() =>
    decisao instanceof Error ? Promise.reject(decisao) : Promise.resolve(decisao),
  );
  const carregar = vi.fn(() =>
    recurso instanceof Error ? Promise.reject(recurso) : Promise.resolve(recurso),
  );
  const registrarDecisao = vi.fn();
  const { exigirPolitica } = criarGuardsDePolitica({ motor: { avaliar }, registrarDecisao });
  return { guard: exigirPolitica('user', 'read', carregar), avaliar, carregar, registrarDecisao };
}

const PERMITIDO: Decisao = { effect: 'permit', policyId: 'p-1', reason: 'matched' };
const NEGADO: Decisao = { effect: 'deny', reason: 'no-applicable-policy' };

describe('caminho autorizado', () => {
  it('permit não responde nada — a cadeia segue para o handler', async () => {
    const { guard, avaliar } = guardCom(PERMITIDO, { owner_id: 'u-1' });
    const espiao = respostaEspiada();
    await guard(requisicao(), espiao.resposta);
    expect(espiao.status()).toBeUndefined();
    expect(avaliar).toHaveBeenCalledTimes(1);
  });

  it('monta o contexto com sujeito, recurso, ação e ambiente', async () => {
    const { guard, avaliar } = guardCom(PERMITIDO, { owner_id: 'u-1' });
    await guard(requisicao(), respostaEspiada().resposta);
    const contexto = avaliar.mock.calls[0]?.[0] as ContextoDeDecisao;
    expect(contexto.subject).toEqual({ sub: 'u-1', roles: ['operator'], perm: ['users:read'] });
    expect(contexto.resourceType).toBe('user');
    expect(contexto.resource).toEqual({ owner_id: 'u-1' });
    expect(contexto.action).toBe('read');
    expect(contexto.env.ip).toBe('10.0.0.9');
    expect(contexto.env.now).toBeInstanceOf(Date);
  });

  it('registra a decisão com o id da política decisiva', async () => {
    const { guard, registrarDecisao } = guardCom(PERMITIDO, { owner_id: 'u-1' });
    await guard(requisicao(), respostaEspiada().resposta);
    expect(registrarDecisao).toHaveBeenCalledWith({
      sujeito_id: 'u-1',
      resource_type: 'user',
      acao: 'read',
      effect: 'permit',
      policy_id: 'p-1',
    });
  });
});

describe('fail closed', () => {
  it('deny responde 403 genérico', async () => {
    const { guard } = guardCom(NEGADO, { owner_id: 'outro' });
    const espiao = respostaEspiada();
    await guard(requisicao(), espiao.resposta);
    expect(espiao.status()).toBe(403);
    expect(espiao.corpo()?.['type']).toContain('authorization-denied');
  });

  it('exceção do motor responde 403, não 500', async () => {
    const { guard } = guardCom(new Error('pg fora do ar'), { owner_id: 'u-1' });
    const espiao = respostaEspiada();
    await expect(guard(requisicao(), espiao.resposta)).resolves.toBeUndefined();
    expect(espiao.status()).toBe(403);
  });

  it('exceção do carregador de recurso responde 403, não 500', async () => {
    const { guard, avaliar } = guardCom(PERMITIDO, new Error('select falhou'));
    const espiao = respostaEspiada();
    await expect(guard(requisicao(), espiao.resposta)).resolves.toBeUndefined();
    expect(espiao.status()).toBe(403);
    expect(avaliar).not.toHaveBeenCalled();
  });

  it('usuário ausente (guard fora de ordem) responde 403 sem avaliar', async () => {
    const { guard, avaliar, carregar } = guardCom(PERMITIDO, { owner_id: 'u-1' });
    const espiao = respostaEspiada();
    await guard(requisicao(false), espiao.resposta);
    expect(espiao.status()).toBe(403);
    expect(carregar).not.toHaveBeenCalled();
    expect(avaliar).not.toHaveBeenCalled();
  });
});

describe('recurso inexistente', () => {
  it('responde 404 antes de consultar a política', async () => {
    const { guard, avaliar } = guardCom(PERMITIDO, null);
    const espiao = respostaEspiada();
    await guard(requisicao(), espiao.resposta);
    expect(espiao.status()).toBe(404);
    expect(espiao.corpo()?.['type']).toContain('resource-not-found');
    expect(avaliar).not.toHaveBeenCalled();
  });
});

describe('guard sem logger injetado', () => {
  it('decide normalmente', async () => {
    const avaliar = vi.fn(() => Promise.resolve(PERMITIDO));
    const { exigirPolitica } = criarGuardsDePolitica({ motor: { avaliar } });
    const guard = exigirPolitica('user', 'read', () => Promise.resolve({ owner_id: 'u-1' }));
    const espiao = respostaEspiada();
    await guard(requisicao(), espiao.resposta);
    expect(espiao.status()).toBeUndefined();
  });
});
