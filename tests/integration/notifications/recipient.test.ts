/**
 * Cobre a resolução de destinatário contra um PostgreSQL real.
 *
 * É o ponto em que a plataforma sai da trilha anônima e descobre para quem mandar. Duas
 * coisas precisam ser verdade: o e-mail vem da fonte certa, e nada além dele vem junto.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { criarResolvedorDeDestinatario } from '../../../src/modules/notifications/repositories/recipient.repository.js';
import type { ResolvedorDeDestinatario } from '../../../src/modules/notifications/interfaces/destinatario.port.js';
import { urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparUsuarios, recriarSchema } from '../users/schema.js';

const EMAIL = 'destinatario@iam.local';

let pool: Pool;
let resolvedor: ResolvedorDeDestinatario;

async function criarUsuario(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, status) VALUES ($1, 'hash-fantasma', 'active') RETURNING id",
    [email],
  );
  if (rows[0] === undefined) throw new Error('usuário não criado');
  return rows[0].id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 2 });
  await recriarSchema(pool);
  resolvedor = criarResolvedorDeDestinatario({ pool });
});

beforeEach(async () => {
  await limparUsuarios(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('emailDe', () => {
  it('devolve o e-mail do usuário', async () => {
    const id = await criarUsuario(EMAIL);

    expect(await resolvedor.emailDe(id)).toBe(EMAIL);
  });

  it('usuário inexistente devolve null — não há para quem mandar', async () => {
    expect(await resolvedor.emailDe('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('id malformado devolve null em vez de estourar', async () => {
    // O ator vem de um evento de auditoria; um valor inesperado ali não pode virar exceção
    // solta fora do caminho da requisição.
    expect(await resolvedor.emailDe('nao-e-uuid')).toBeNull();
  });

  it('falha de consulta devolve null e chama o observador', async () => {
    let falhou = false;
    const quebrado = criarResolvedorDeDestinatario({
      pool: { query: () => Promise.reject(new Error('pg fora')) } as unknown as Pool,
      aoFalhar: () => {
        falhou = true;
      },
    });

    expect(await quebrado.emailDe('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(falhou).toBe(true);
  });

  it('a consulta não traz hash de senha', async () => {
    const id = await criarUsuario(EMAIL);
    const capturadas: string[] = [];
    const espiao = criarResolvedorDeDestinatario({
      pool: {
        query: (texto: string, valores: unknown[]) => {
          capturadas.push(texto);
          return pool.query(texto, valores);
        },
      } as unknown as Pool,
    });

    await espiao.emailDe(id);

    // Porta estreita: o que este módulo não pede, ele não pode vazar para o provedor.
    expect(capturadas[0]).not.toContain('password_hash');
    expect(capturadas[0]).not.toContain('*');
  });
});
