/**
 * Cobre o repositório concreto contra PostgreSQL real: o schema da 0001 (T01), o conflito
 * de e-mail (UNIQUE), o `updated_at` que muda no update, o cascade do delete e a listagem
 * com filtro/paginação.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import {
  criarRepositorioDeUsuario,
  type RepositorioDeUsuario,
} from '../../../src/modules/users/repositories/user.repository.js';
import { ErroDeUsuario } from '../../../src/modules/users/errors/user-error.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from './schema.js';

const servico = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
let pool: Pool;
let repo: RepositorioDeUsuario;

async function hash(): Promise<string> {
  return servico.gerarHash('S3nh@MuitoForte!');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 3 });
  await recriarSchema(pool);
  repo = criarRepositorioDeUsuario(pool);
});

beforeEach(async () => {
  await limparUsuarios(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('schema 0001 (T01)', () => {
  it('tem users com email case-insensitive (citext) e UNIQUE', async () => {
    const h = await hash();
    await repo.criar({ email: 'Caso@Iam.Local', passwordHash: h });
    // citext: a busca por outra caixa acha o mesmo registro.
    expect(await repo.buscarPorEmail('caso@iam.local')).not.toBeNull();
    // UNIQUE case-insensitive: recriar com outra caixa conflita.
    await expect(repo.criar({ email: 'CASO@iam.local', passwordHash: h })).rejects.toBeInstanceOf(
      ErroDeUsuario,
    );
  });

  it('recusa status fora do CHECK (active/blocked)', async () => {
    await expect(
      pool.query("INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'zumbi')", [
        'x@iam.local',
        await hash(),
      ]),
    ).rejects.toBeTruthy();
  });
});

describe('criar', () => {
  it('devolve a entidade e rejeita e-mail duplicado com email-conflito', async () => {
    const h = await hash();
    const u = await repo.criar({ email: 'a@iam.local', passwordHash: h });
    expect(u.id).toBeTruthy();
    expect(u.status).toBe('active');
    await expect(repo.criar({ email: 'a@iam.local', passwordHash: h })).rejects.toMatchObject({
      codigo: 'email-conflito',
    });
  });
});

describe('updated_at', () => {
  it('muda quando o status é alterado', async () => {
    const u = await repo.criar({ email: 'a@iam.local', passwordHash: await hash() });
    // Garante uma diferença temporal observável entre criação e update.
    await new Promise((r) => setTimeout(r, 10));
    const atualizado = await repo.definirStatus(u.id, 'blocked');
    expect(atualizado?.status).toBe('blocked');
    expect(atualizado?.atualizadoEm.getTime()).toBeGreaterThan(u.atualizadoEm.getTime());
  });
});

describe('remover (cascade)', () => {
  it('apaga o usuário e o histórico de senha referenciado (FK cascade)', async () => {
    const u = await repo.criar({ email: 'a@iam.local', passwordHash: await hash() });
    await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)', [
      u.id,
      await hash(),
    ]);

    expect(await repo.remover(u.id)).toBe(true);
    expect(await repo.buscarPorId(u.id)).toBeNull();
    const { rows } = await pool.query('SELECT 1 FROM password_history WHERE user_id = $1', [u.id]);
    expect(rows).toHaveLength(0);
  });

  it('devolve false ao remover id inexistente', async () => {
    expect(await repo.remover('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('listar e contar', () => {
  it('filtra por status e pagina', async () => {
    const h = await hash();
    const a = await repo.criar({ email: 'a@iam.local', passwordHash: h });
    await repo.criar({ email: 'b@iam.local', passwordHash: h });
    await repo.definirStatus(a.id, 'blocked');

    expect(await repo.contar()).toBe(2);
    expect(await repo.contar('blocked')).toBe(1);

    const bloqueados = await repo.listar({ limite: 10, offset: 0, status: 'blocked' });
    expect(bloqueados).toHaveLength(1);
    expect(bloqueados[0]?.email).toBe('a@iam.local');

    const pagina = await repo.listar({ limite: 1, offset: 0 });
    expect(pagina).toHaveLength(1);
  });
});
