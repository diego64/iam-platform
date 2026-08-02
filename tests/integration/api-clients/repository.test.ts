/**
 * Cobre o repositório de clientes contra PostgreSQL real: a criação atômica com escopos, o
 * soft delete que precisa negar a autenticação, a rotação de segredo que nunca acumula uma
 * terceira via, e o throttle do último uso — que vive na cláusula WHERE justamente para não
 * depender de coordenação entre réplicas.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  criarRepositorioDeClientes,
  type EntradaDeCliente,
  type RepositorioDeClientes,
} from '../../../src/modules/api-clients/repositories/api-client.repository.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparClientes, recriarSchemaDeClientes } from './schema.js';

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
const HASH_NOVO = 'scrypt$16384$8$1$bm92bw==$bm92b2hhc2g=';
const ID_INEXISTENTE = '00000000-0000-0000-0000-000000000000';

let pool: Pool;
let repo: RepositorioDeClientes;
let contador = 0;

async function idDePermissao(nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM permissions WHERE name = $1', [
    nome,
  ]);
  return rows[0]?.id ?? '';
}

function entrada(campos: Partial<EntradaDeCliente> = {}): EntradaDeCliente {
  contador += 1;
  return {
    clientId: `cli_teste${String(contador)}`,
    secretHash: HASH,
    name: `cliente-${String(contador)}`,
    grantTypes: ['client_credentials'],
    permissionIds: [],
    ...campos,
  };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 4 });
  await recriarSchemaDeClientes(pool);
  repo = criarRepositorioDeClientes(pool);
});

beforeEach(async () => {
  await limparClientes(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('criar', () => {
  it('grava o cliente com os escopos pedidos', async () => {
    const leitura = await idDePermissao('clients:read');
    const escrita = await idDePermissao('clients:write');

    const criado = await repo.criar(entrada({ permissionIds: [leitura, escrita] }));

    expect(criado.escopos).toEqual(['clients:read', 'clients:write']);
    expect(criado.status).toBe('active');
    expect(criado.grantTypes).toEqual(['client_credentials']);
  });

  it('aceita cliente sem escopo nenhum', async () => {
    const criado = await repo.criar(entrada());

    expect(criado.escopos).toEqual([]);
  });

  // Um cliente com metade dos escopos parece configurado e autoriza menos do que deveria.
  it('não deixa cliente pela metade quando um escopo é inválido', async () => {
    const antes = (await repo.listar({ limit: 50, offset: 0 })).total;

    await expect(repo.criar(entrada({ permissionIds: [ID_INEXISTENTE] }))).rejects.toThrow();

    expect((await repo.listar({ limit: 50, offset: 0 })).total).toBe(antes);
  });

  it('propaga a violação de nome duplicado', async () => {
    await repo.criar(entrada({ name: 'repetido' }));

    await expect(repo.criar(entrada({ name: 'repetido' }))).rejects.toMatchObject({
      code: '23505',
    });
  });
});

describe('buscarPorClientId', () => {
  it('devolve as credenciais para autenticar', async () => {
    const criado = await repo.criar(entrada());

    const credenciais = await repo.buscarPorClientId(criado.clientId);

    expect(credenciais?.secretHash).toBe(HASH);
    expect(credenciais?.previousSecretHash).toBeNull();
    expect(credenciais?.status).toBe('active');
  });

  it('encontra cliente desabilitado — quem decide negar é o serviço, não a consulta', async () => {
    const criado = await repo.criar(entrada());
    await repo.atualizar(criado.id, { status: 'disabled' });

    expect((await repo.buscarPorClientId(criado.clientId))?.status).toBe('disabled');
  });

  // O soft delete precisa negar a autenticação tão firmemente quanto o hard delete negaria.
  it('não encontra cliente removido', async () => {
    const criado = await repo.criar(entrada());
    await repo.removerLogicamente(criado.id);

    expect(await repo.buscarPorClientId(criado.clientId)).toBeNull();
  });

  it('devolve null para client_id inexistente', async () => {
    expect(await repo.buscarPorClientId('cli_naoexiste')).toBeNull();
  });
});

describe('listar', () => {
  it('esconde os removidos por padrão e os mostra quando pedidos', async () => {
    const vivo = await repo.criar(entrada());
    const morto = await repo.criar(entrada());
    await repo.removerLogicamente(morto.id);

    const padrao = await repo.listar({ limit: 50, offset: 0 });
    const removidos = await repo.listar({ status: 'deleted', limit: 50, offset: 0 });

    expect(padrao.items.map((c) => c.id)).toEqual([vivo.id]);
    expect(removidos.items.map((c) => c.id)).toEqual([morto.id]);
  });

  it('devolve o total da consulta inteira, não o da página', async () => {
    await repo.criar(entrada());
    await repo.criar(entrada());
    await repo.criar(entrada());

    const pagina = await repo.listar({ limit: 2, offset: 0 });

    expect(pagina.items).toHaveLength(2);
    expect(pagina.total).toBe(3);
  });

  it('devolve total zero sem estourar quando não há nada', async () => {
    const vazio = await repo.listar({ limit: 50, offset: 0 });

    expect(vazio.items).toEqual([]);
    expect(vazio.total).toBe(0);
  });
});

describe('atualizar', () => {
  it('altera só os campos informados', async () => {
    const criado = await repo.criar(entrada({ description: 'original' }));

    const atualizado = await repo.atualizar(criado.id, { name: 'novo-nome' });

    expect(atualizado?.name).toBe('novo-nome');
    expect(atualizado?.description).toBe('original');
  });

  it('permite limpar a descrição explicitamente', async () => {
    const criado = await repo.criar(entrada({ description: 'para apagar' }));

    const atualizado = await repo.atualizar(criado.id, { description: null });

    expect(atualizado?.description).toBeNull();
  });

  it('substitui o conjunto de escopos por completo, sem acumular', async () => {
    const leitura = await idDePermissao('clients:read');
    const escrita = await idDePermissao('clients:write');
    const criado = await repo.criar(entrada({ permissionIds: [leitura, escrita] }));

    const atualizado = await repo.atualizar(criado.id, { permissionIds: [escrita] });

    expect(atualizado?.escopos).toEqual(['clients:write']);
  });

  it('não toca nos escopos quando eles não são informados', async () => {
    const leitura = await idDePermissao('clients:read');
    const criado = await repo.criar(entrada({ permissionIds: [leitura] }));

    const atualizado = await repo.atualizar(criado.id, { name: 'so-o-nome' });

    expect(atualizado?.escopos).toEqual(['clients:read']);
  });

  // NULL aqui é valor legítimo — significa "usar o TTL global" —, então precisa ser
  // distinguível de "não mexer neste campo".
  it('distingue limpar o TTL de não informá-lo', async () => {
    const criado = await repo.criar(entrada({ accessTokenTtlSegundos: 600 }));

    const semMexer = await repo.atualizar(criado.id, { name: 'x' });
    expect(semMexer?.accessTokenTtlSegundos).toBe(600);

    const limpo = await repo.atualizar(criado.id, { accessTokenTtlSegundos: null });
    expect(limpo?.accessTokenTtlSegundos).toBeNull();
  });

  it('devolve null para cliente inexistente ou removido', async () => {
    const criado = await repo.criar(entrada());
    await repo.removerLogicamente(criado.id);

    expect(await repo.atualizar(criado.id, { name: 'x' })).toBeNull();
    expect(await repo.atualizar(ID_INEXISTENTE, { name: 'x' })).toBeNull();
  });
});

describe('removerLogicamente', () => {
  it('marca como removido e preserva a linha', async () => {
    const criado = await repo.criar(entrada());

    expect(await repo.removerLogicamente(criado.id)).toBe(true);
    expect((await repo.buscarPorId(criado.id))?.status).toBe('deleted');
  });

  it('é falso na segunda vez', async () => {
    const criado = await repo.criar(entrada());
    await repo.removerLogicamente(criado.id);

    expect(await repo.removerLogicamente(criado.id)).toBe(false);
  });
});

describe('rotacionarSegredo', () => {
  it('promove o hash corrente a anterior e marca a expiração', async () => {
    const criado = await repo.criar(entrada());

    const resultado = await repo.rotacionarSegredo(criado.id, {
      novoHash: HASH_NOVO,
      sobreposicaoMs: 3_600_000,
    });

    const credenciais = await repo.buscarPorClientId(criado.clientId);
    expect(credenciais?.secretHash).toBe(HASH_NOVO);
    expect(credenciais?.previousSecretHash).toBe(HASH);
    expect(resultado?.segredoAnteriorExpiraEm?.getTime()).toBeGreaterThan(Date.now());
  });

  it('com sobreposição zero, não deixa segredo anterior nenhum', async () => {
    const criado = await repo.criar(entrada());

    const resultado = await repo.rotacionarSegredo(criado.id, {
      novoHash: HASH_NOVO,
      sobreposicaoMs: 0,
    });

    const credenciais = await repo.buscarPorClientId(criado.clientId);
    expect(credenciais?.previousSecretHash).toBeNull();
    expect(credenciais?.previousSecretExpiresAt).toBeNull();
    expect(resultado?.segredoAnteriorExpiraEm).toBeNull();
  });

  // A coluna é uma só: rotacionar de novo substitui, nunca acumula uma terceira via viva.
  it('rotacionar duas vezes deixa só o penúltimo como anterior', async () => {
    const criado = await repo.criar(entrada());
    const terceiro = 'scrypt$16384$8$1$dGVy$dGVyY2Vpcm8=';

    await repo.rotacionarSegredo(criado.id, { novoHash: HASH_NOVO, sobreposicaoMs: 3_600_000 });
    await repo.rotacionarSegredo(criado.id, { novoHash: terceiro, sobreposicaoMs: 3_600_000 });

    const credenciais = await repo.buscarPorClientId(criado.clientId);
    expect(credenciais?.secretHash).toBe(terceiro);
    expect(credenciais?.previousSecretHash).toBe(HASH_NOVO);
  });

  it('devolve null para cliente removido', async () => {
    const criado = await repo.criar(entrada());
    await repo.removerLogicamente(criado.id);

    expect(
      await repo.rotacionarSegredo(criado.id, { novoHash: HASH_NOVO, sobreposicaoMs: 0 }),
    ).toBeNull();
  });
});

describe('revogarSegredoAnterior', () => {
  it('encerra a sobreposição em andamento', async () => {
    const criado = await repo.criar(entrada());
    await repo.rotacionarSegredo(criado.id, { novoHash: HASH_NOVO, sobreposicaoMs: 3_600_000 });

    expect(await repo.revogarSegredoAnterior(criado.id)).toBe(true);

    const credenciais = await repo.buscarPorClientId(criado.clientId);
    expect(credenciais?.previousSecretHash).toBeNull();
    expect(credenciais?.previousSecretExpiresAt).toBeNull();
  });

  it('é falso quando não havia sobreposição', async () => {
    const criado = await repo.criar(entrada());

    expect(await repo.revogarSegredoAnterior(criado.id)).toBe(false);
  });
});

describe('registrarUso', () => {
  it('grava o primeiro uso', async () => {
    const criado = await repo.criar(entrada());

    await repo.registrarUso(criado.id, 300_000);

    expect((await repo.buscarPorId(criado.id))?.ultimoUsoEm).toBeInstanceOf(Date);
  });

  // O throttle está no WHERE: duas réplicas autenticando o mesmo cliente ao mesmo tempo não
  // geram duas escritas, porque a segunda simplesmente não casa.
  it('não regrava dentro da janela do throttle', async () => {
    const criado = await repo.criar(entrada());
    await repo.registrarUso(criado.id, 300_000);
    const primeiro = (await repo.buscarPorId(criado.id))?.ultimoUsoEm;

    await repo.registrarUso(criado.id, 300_000);

    expect((await repo.buscarPorId(criado.id))?.ultimoUsoEm?.getTime()).toBe(primeiro?.getTime());
  });

  it('regrava quando a janela já passou', async () => {
    const criado = await repo.criar(entrada());
    await repo.registrarUso(criado.id, 300_000);
    const primeiro = (await repo.buscarPorId(criado.id))?.ultimoUsoEm;

    await repo.registrarUso(criado.id, 0);

    expect((await repo.buscarPorId(criado.id))?.ultimoUsoEm?.getTime()).toBeGreaterThanOrEqual(
      primeiro?.getTime() ?? 0,
    );
  });
});
