/**
 * Fuzz do resolvedor de atributo. Caminhos vêm de política — dado administrável —
 * então a propriedade que precisa valer para *qualquer* entrada é dupla: nunca lançar (uma
 * exceção viraria 500 no meio da autorização) e nunca devolver algo alcançado pela cadeia de
 * protótipos (um `constructor` resolvido seria a porta da poluição de protótipo).
 *
 * Sem biblioteca de property testing: o gerador abaixo é um punhado de linhas, e não vale
 * uma dependência nova.
 */
import { describe, expect, it } from 'vitest';
import { resolverAtributo } from '../../../../src/modules/abac/services/condition-evaluator.js';
import type { ContextoDeDecisao } from '../../../../src/modules/abac/types/abac.types.js';

const SEGMENTOS = [
  '__proto__',
  'prototype',
  'constructor',
  'toString',
  'subject',
  'resource',
  'env',
  'action',
  'sub',
  'owner_id',
  'roles',
  'ip',
  'now',
  '',
  '0',
  'a'.repeat(64),
  'valueOf',
  'hasOwnProperty',
];

/** Gerador determinístico — a semente fixa mantém a falha reproduzível. */
function criarAleatorio(semente: number): () => number {
  let estado = semente;
  return () => {
    estado = (estado * 1103515245 + 12345) % 2147483648;
    return estado / 2147483648;
  };
}

function caminhoAleatorio(rnd: () => number): string {
  const partes = 1 + Math.floor(rnd() * 5);
  return Array.from(
    { length: partes },
    () => SEGMENTOS[Math.floor(rnd() * SEGMENTOS.length)] ?? '',
  ).join('.');
}

const CONTEXTO: ContextoDeDecisao = {
  subject: { sub: 'u-1', roles: ['operator'], perm: [] },
  resourceType: 'user',
  resource: { owner_id: 'u-1', aninhado: { profundo: 'valor' } },
  action: 'read',
  env: { ip: '10.0.0.1', now: new Date('2026-08-02T12:00:00Z') },
};

/** Valores que só existem via protótipo — se algum vazar, a resolução furou o isolamento. */
function veioDoPrototipo(valor: unknown): boolean {
  return typeof valor === 'function' || valor === Object.prototype;
}

describe('propriedades do resolvedor de atributo', () => {
  it('nunca lança e nunca devolve algo vindo do protótipo', () => {
    const rnd = criarAleatorio(20260802);
    for (let i = 0; i < 20_000; i += 1) {
      const caminho = caminhoAleatorio(rnd);
      const resolvido = resolverAtributo(caminho, CONTEXTO);
      expect(veioDoPrototipo(resolvido)).toBe(false);
    }
  });

  it('resolve apenas propriedades próprias e planas', () => {
    for (const caminho of [
      '__proto__',
      'constructor',
      'subject.constructor',
      'subject.hasOwnProperty',
      'resource.toString',
      'resource.aninhado.__proto__',
      'action.length',
      'subject.roles.length',
    ]) {
      expect(resolverAtributo(caminho, CONTEXTO)).toBeUndefined();
    }
  });

  it('a varredura não polui o protótipo de Object', () => {
    resolverAtributo('__proto__.poluido', CONTEXTO);
    resolverAtributo('constructor.prototype.poluido', CONTEXTO);
    expect(({} as Record<string, unknown>)['poluido']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('poluido');
  });
});
