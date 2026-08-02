/**
 * Exercita o repositório de políticas contra PostgreSQL real: CRUD, unicidade de `name` e —
 * o caminho quente — a seleção por curinga que o PDP faz a cada decisão. Um erro de curinga
 * aqui não quebra teste nenhum de unidade, mas apaga políticas do conjunto avaliado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchemaAbac } from './schema.js';
import {
  criarRepositorioDePolitica,
  type DadosDePolitica,
  type RepositorioDePolitica,
} from '../../../src/modules/abac/repositories/policy.repository.js';
import { ErroDeAbac } from '../../../src/modules/abac/errors/abac.errors.js';
import type { Condicao } from '../../../src/modules/abac/types/abac.types.js';

const POSSE: Condicao = { op: 'eq', attr: 'resource.owner_id', value: { ref: 'subject.sub' } };

let pool: Pool;
let repo: RepositorioDePolitica;

function dados(parcial: Partial<DadosDePolitica> = {}): DadosDePolitica {
  return {
    name: 'politica-teste',
    description: null,
    effect: 'permit',
    resourceType: 'user',
    action: 'read',
    condition: POSSE,
    priority: 0,
    enabled: true,
    ...parcial,
  };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaAbac(pool);
  repo = criarRepositorioDePolitica(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Preserva o seed (`system-ownership`) e limpa só o que cada teste cria.
  await pool.query('DELETE FROM policies WHERE NOT is_system');
});

describe('CRUD de políticas', () => {
  it('cria e lê de volta, com a condição preservada como JSON', async () => {
    const criada = await repo.criar(dados({ name: 'own-user', description: 'posse' }));
    expect(criada.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(criada.isSystem).toBe(false);

    const lida = await repo.buscarPorId(criada.id);
    expect(lida).not.toBeNull();
    expect(lida?.condition).toEqual(POSSE);
    expect(lida?.description).toBe('posse');
    expect(lida?.effect).toBe('permit');
  });

  it('devolve null para id inexistente', async () => {
    expect(await repo.buscarPorId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('recusa nome duplicado com erro de domínio', async () => {
    await repo.criar(dados({ name: 'duplicada' }));
    await expect(repo.criar(dados({ name: 'duplicada' }))).rejects.toBeInstanceOf(ErroDeAbac);
    await expect(repo.criar(dados({ name: 'duplicada' }))).rejects.toMatchObject({
      codigo: 'politica-conflito',
    });
  });

  it('atualiza todos os campos gravaveis', async () => {
    const criada = await repo.criar(dados({ name: 'antes' }));
    const negacao: Condicao = {
      op: 'ne',
      attr: 'resource.owner_id',
      value: { ref: 'subject.sub' },
    };
    const atualizada = await repo.atualizar(
      criada.id,
      dados({
        name: 'depois',
        description: 'nova',
        effect: 'deny',
        resourceType: 'session',
        action: '*',
        condition: negacao,
        priority: 10,
        enabled: false,
      }),
    );
    expect(atualizada).toMatchObject({
      name: 'depois',
      effect: 'deny',
      resourceType: 'session',
      action: '*',
      priority: 10,
      enabled: false,
    });
    expect(atualizada?.condition).toEqual(negacao);
  });

  it('atualizar id inexistente devolve null e nome duplicado conflita', async () => {
    await repo.criar(dados({ name: 'ocupada' }));
    const outra = await repo.criar(dados({ name: 'livre' }));
    expect(await repo.atualizar('00000000-0000-0000-0000-000000000000', dados())).toBeNull();
    await expect(repo.atualizar(outra.id, dados({ name: 'ocupada' }))).rejects.toMatchObject({
      codigo: 'politica-conflito',
    });
  });

  it('remove e informa quando não havia o que remover', async () => {
    const criada = await repo.criar(dados({ name: 'efemera' }));
    expect(await repo.remover(criada.id)).toBe(true);
    expect(await repo.remover(criada.id)).toBe(false);
    expect(await repo.buscarPorId(criada.id)).toBeNull();
  });
});

describe('listagem e filtros', () => {
  beforeEach(async () => {
    await repo.criar(dados({ name: 'a-user', resourceType: 'user', priority: 1 }));
    await repo.criar(dados({ name: 'b-session', resourceType: 'session', priority: 5 }));
    await repo.criar(dados({ name: 'c-desligada', resourceType: 'user', enabled: false }));
  });

  it('ordena por prioridade decrescente e pagina', async () => {
    const pagina = await repo.listar({ limite: 2, offset: 0 });
    expect(pagina).toHaveLength(2);
    expect(pagina[0]?.name).toBe('b-session');
    const segunda = await repo.listar({ limite: 2, offset: 2 });
    expect(segunda.length).toBeGreaterThan(0);
  });

  it('filtra por resource_type e por enabled', async () => {
    const porTipo = await repo.listar({ resourceType: 'user', limite: 50, offset: 0 });
    expect(porTipo.map((p) => p.name).sort()).toEqual(['a-user', 'c-desligada']);

    const desligadas = await repo.listar({ enabled: false, limite: 50, offset: 0 });
    expect(desligadas.map((p) => p.name)).toEqual(['c-desligada']);

    expect(await repo.contar({ resourceType: 'user' })).toBe(2);
    expect(await repo.contar({ resourceType: 'user', enabled: true })).toBe(1);
    expect(await repo.contar({})).toBe(5); // 3 do teste + as 2 políticas de sistema
  });
});

describe('seleção de políticas aplicáveis (caminho do PDP)', () => {
  it('casa alvo exato, curinga de recurso e curinga de ação', async () => {
    await repo.criar(dados({ name: 'exata', resourceType: 'user', action: 'read' }));
    await repo.criar(dados({ name: 'acao-curinga', resourceType: 'user', action: '*' }));
    await repo.criar(dados({ name: 'recurso-curinga', resourceType: '*', action: 'read' }));
    await repo.criar(dados({ name: 'outro-recurso', resourceType: 'session', action: 'read' }));
    await repo.criar(dados({ name: 'outra-acao', resourceType: 'user', action: 'delete' }));

    const aplicaveis = await repo.listarAplicaveis('user', 'read');
    expect(aplicaveis.map((p) => p.name).sort()).toEqual([
      'acao-curinga',
      'exata',
      'recurso-curinga',
      // As duas políticas de sistema são `*`/`*`, então entram em todo alvo.
      'system-ownership',
      'system-privilege-override',
    ]);
  });

  it('ignora política desligada', async () => {
    await repo.criar(dados({ name: 'ligada', resourceType: 'doc', action: 'read' }));
    await repo.criar(
      dados({ name: 'desligada', resourceType: 'doc', action: 'read', enabled: false }),
    );

    const aplicaveis = await repo.listarAplicaveis('doc', 'read');
    expect(aplicaveis.map((p) => p.name)).not.toContain('desligada');
    expect(aplicaveis.map((p) => p.name)).toContain('ligada');
  });

  it('devolve as de maior prioridade primeiro', async () => {
    await repo.criar(dados({ name: 'baixa', resourceType: 'doc', action: 'read', priority: 1 }));
    await repo.criar(dados({ name: 'alta', resourceType: 'doc', action: 'read', priority: 900 }));

    const aplicaveis = await repo.listarAplicaveis('doc', 'read');
    expect(aplicaveis[0]?.name).toBe('alta');
  });
});
