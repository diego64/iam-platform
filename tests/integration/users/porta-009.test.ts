/**
 * Prova que o repositório concreto da 002 satisfaz a porta `RepositorioDeUsuario` da 009 —
 * o contrato que o módulo de senha consome. A conformidade estrutural é garantida em tempo
 * de compilação pela atribuição ao tipo importado da 009; o comportamento das três
 * operações da porta é exercitado contra o PostgreSQL real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { RepositorioDeUsuario as PortaDaSenha } from '../../../src/modules/password/interfaces/usuario.port.js';
import { criarRepositorioDeUsuario } from '../../../src/modules/users/repositories/user.repository.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from './schema.js';

const servico = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
let pool: Pool;
// A atribuição a `PortaDaSenha` é o cheque de conformidade: se o concreto divergir do
// contrato da 009, isto não compila.
let porta: PortaDaSenha;

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchema(pool);
  porta = criarRepositorioDeUsuario(pool);
});

beforeEach(async () => {
  await limparUsuarios(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('RepositorioDeUsuario (porta da 009) sobre o concreto da 002', () => {
  it('buscarPorEmail devolve o formato que o domínio de senha espera', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id',
      ['a@iam.local', await servico.gerarHash('S3nh@MuitoForte!')],
    );
    const usuario = await porta.buscarPorEmail('a@iam.local');
    expect(usuario).not.toBeNull();
    expect(usuario).toMatchObject({ id: rows[0]?.id, email: 'a@iam.local', status: 'active' });
    expect(usuario?.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('atualizarHash troca o hash corrente, visível por buscarPorId', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id',
      ['b@iam.local', await servico.gerarHash('S3nh@MuitoForte!')],
    );
    const id = rows[0]?.id ?? '';
    const novo = await servico.gerarHash('Outr@Senh@Forte!');
    await porta.atualizarHash(id, novo);

    const usuario = await porta.buscarPorId(id);
    expect(usuario?.passwordHash).toBe(novo);
    expect(await servico.verificar('Outr@Senh@Forte!', usuario?.passwordHash ?? '')).toBe(true);
  });
});
