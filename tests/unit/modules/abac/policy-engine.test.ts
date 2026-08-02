/**
 * O motor é onde "conjunto de políticas" vira "sim ou não". Os casos que importam são os de
 * combinação (deny sempre vence) e os de ausência (sem política aplicável ⇒ deny), porque é
 * neles que um motor mal escrito falha aberto.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  criarMotorDePoliticas,
  type DependenciasDoMotor,
  type MotorDePoliticas,
} from '../../../../src/modules/abac/services/policy-engine.js';
import type {
  Condicao,
  ContextoDeDecisao,
  Politica,
} from '../../../../src/modules/abac/types/abac.types.js';

const SEMPRE: Condicao = { op: 'eq', attr: 'action', value: 'read' };
const NUNCA: Condicao = { op: 'eq', attr: 'action', value: 'jamais' };
const POSSE: Condicao = { op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } };

function politica(parcial: Partial<Politica> & Pick<Politica, 'id' | 'effect'>): Politica {
  return {
    name: parcial.id,
    description: null,
    resourceType: 'user',
    action: 'read',
    condition: SEMPRE,
    priority: 0,
    enabled: true,
    isSystem: false,
    ...parcial,
  };
}

const CONTEXTO: ContextoDeDecisao = {
  subject: { sub: 'u-1', roles: [], perm: [] },
  resourceType: 'user',
  resource: { owner_id: 'u-1' },
  action: 'read',
  env: { now: new Date('2026-08-02T12:00:00Z') },
};

function motorCom(
  politicas: Politica[],
  extras: Partial<DependenciasDoMotor> = {},
): { motor: MotorDePoliticas; listarAplicaveis: Mock } {
  const listarAplicaveis = vi.fn().mockResolvedValue(politicas);
  const motor = criarMotorDePoliticas({ politicas: { listarAplicaveis }, ...extras });
  return { motor, listarAplicaveis };
}

describe('combinação de políticas', () => {
  it('deny vence permit quando ambos estão satisfeitos', async () => {
    const { motor } = motorCom([
      politica({ id: 'p-permit', effect: 'permit' }),
      politica({ id: 'p-deny', effect: 'deny' }),
    ]);
    await expect(motor.avaliar(CONTEXTO)).resolves.toEqual({
      effect: 'deny',
      policyId: 'p-deny',
      reason: 'matched',
    });
  });

  it('deny vence mesmo com prioridade menor que a do permit', async () => {
    const { motor } = motorCom([
      politica({ id: 'p-permit', effect: 'permit', priority: 900 }),
      politica({ id: 'p-deny', effect: 'deny', priority: 0 }),
    ]);
    const decisao = await motor.avaliar(CONTEXTO);
    expect(decisao.effect).toBe('deny');
  });

  it('permite quando só há permit satisfeito', async () => {
    const { motor } = motorCom([
      politica({ id: 'p-permit', effect: 'permit', condition: POSSE }),
      politica({ id: 'p-deny', effect: 'deny', condition: NUNCA }),
    ]);
    await expect(motor.avaliar(CONTEXTO)).resolves.toEqual({
      effect: 'permit',
      policyId: 'p-permit',
      reason: 'matched',
    });
  });

  it('a política decisiva do permit é a de maior prioridade (ordem do repositório)', async () => {
    const { motor } = motorCom([
      politica({ id: 'p-alta', effect: 'permit', priority: 900 }),
      politica({ id: 'p-baixa', effect: 'permit', priority: 1 }),
    ]);
    const decisao = await motor.avaliar(CONTEXTO);
    expect(decisao.policyId).toBe('p-alta');
  });
});

describe('default-deny', () => {
  it('nega quando não há política aplicável', async () => {
    const { motor } = motorCom([]);
    await expect(motor.avaliar(CONTEXTO)).resolves.toEqual({
      effect: 'deny',
      reason: 'no-applicable-policy',
    });
  });

  it('nega quando há políticas aplicáveis mas nenhuma satisfeita', async () => {
    const { motor } = motorCom([politica({ id: 'p', effect: 'permit', condition: NUNCA })]);
    const decisao = await motor.avaliar(CONTEXTO);
    expect(decisao).toEqual({ effect: 'deny', reason: 'no-applicable-policy' });
  });

  it('nega quando a posse não bate', async () => {
    const { motor } = motorCom([politica({ id: 'p', effect: 'permit', condition: POSSE })]);
    const decisao = await motor.avaliar({
      ...CONTEXTO,
      resource: { owner_id: 'outro-usuario' },
    });
    expect(decisao.effect).toBe('deny');
  });
});

describe('cache', () => {
  it('reusa o conjunto de políticas dentro do TTL', async () => {
    const { motor, listarAplicaveis } = motorCom([politica({ id: 'p', effect: 'permit' })], {
      agora: () => 1_000,
    });
    await motor.avaliar(CONTEXTO);
    await motor.avaliar(CONTEXTO);
    expect(listarAplicaveis).toHaveBeenCalledTimes(1);
  });

  it('consulta de novo por alvo diferente', async () => {
    const { motor, listarAplicaveis } = motorCom([politica({ id: 'p', effect: 'permit' })]);
    await motor.avaliar(CONTEXTO);
    await motor.avaliar({ ...CONTEXTO, action: 'delete' });
    expect(listarAplicaveis).toHaveBeenCalledTimes(2);
  });

  it('expira o cache depois do TTL', async () => {
    let relogio = 1_000;
    const { motor, listarAplicaveis } = motorCom([politica({ id: 'p', effect: 'permit' })], {
      ttlMs: 5_000,
      agora: () => relogio,
    });
    await motor.avaliar(CONTEXTO);
    relogio += 5_001;
    await motor.avaliar(CONTEXTO);
    expect(listarAplicaveis).toHaveBeenCalledTimes(2);
  });

  it('invalidar() faz a próxima decisão refletir a escrita', async () => {
    const listarAplicaveis = vi
      .fn()
      .mockResolvedValueOnce([politica({ id: 'p-permit', effect: 'permit' })])
      .mockResolvedValueOnce([politica({ id: 'p-deny', effect: 'deny' })]);
    const motor = criarMotorDePoliticas({ politicas: { listarAplicaveis } });

    expect((await motor.avaliar(CONTEXTO)).effect).toBe('permit');
    motor.invalidar();
    expect((await motor.avaliar(CONTEXTO)).effect).toBe('deny');
    expect(listarAplicaveis).toHaveBeenCalledTimes(2);
  });
});

describe('observabilidade e falhas', () => {
  it('conta a decisão e mede a avaliação', async () => {
    const medidor = { contarDecisao: vi.fn(), observarAvaliacao: vi.fn() };
    const { motor } = motorCom([politica({ id: 'p', effect: 'permit' })], { medidor });
    await motor.avaliar(CONTEXTO);
    expect(medidor.contarDecisao).toHaveBeenCalledWith('permit', 'user');
    expect(medidor.observarAvaliacao).toHaveBeenCalledTimes(1);
  });

  it('propaga erro do repositório em vez de mascarar como no-applicable-policy', async () => {
    const listarAplicaveis = vi.fn().mockRejectedValue(new Error('pg fora do ar'));
    const motor = criarMotorDePoliticas({ politicas: { listarAplicaveis } });
    await expect(motor.avaliar(CONTEXTO)).rejects.toThrow('pg fora do ar');
  });
});
