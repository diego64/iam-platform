/**
 * Cobre o UserService com repositório e portas em fake: criação (hash + política),
 * conflito de e-mail, ciclo de status com revogação de sessões e remoção.
 *
 * Custo de scrypt reduzido (N=2^14) para a suíte não pagar o custo de produção.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { criarServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import {
  criarUserService,
  type UserService,
} from '../../../../src/modules/users/services/user.service.js';
import { ErroDeUsuario } from '../../../../src/modules/users/errors/user-error.js';
import {
  criarRepositorioDeUsuarioFake,
  criarRevogadorDeSessoesFake,
  type RepositorioDeUsuarioFake,
  type RevogadorDeSessoesFake,
} from '../../../mocks/usuarios.js';

const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
const EMAIL = 'novo@iam.local';
const SENHA = 'S3nh@MuitoForte!';

let repositorio: RepositorioDeUsuarioFake;
let sessoes: RevogadorDeSessoesFake;
let service: UserService;

beforeEach(() => {
  repositorio = criarRepositorioDeUsuarioFake();
  sessoes = criarRevogadorDeSessoesFake();
  service = criarUserService({ repositorio, servicoDeSenha, sessoes });
});

describe('criar', () => {
  it('hasheia a senha e persiste sem a senha em claro', async () => {
    const usuario = await service.criar({ email: EMAIL, senha: SENHA });
    expect(usuario.email).toBe(EMAIL);
    expect(usuario.status).toBe('active');
    expect(usuario.passwordHash).not.toContain(SENHA);
    expect(usuario.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(await servicoDeSenha.verificar(SENHA, usuario.passwordHash)).toBe(true);
  });

  it('rejeita e-mail duplicado com email-conflito', async () => {
    await service.criar({ email: EMAIL, senha: SENHA });
    await expect(service.criar({ email: EMAIL, senha: SENHA })).rejects.toMatchObject({
      codigo: 'email-conflito',
    });
  });

  it('rejeita senha fraca pela política (domínio)', async () => {
    await expect(service.criar({ email: EMAIL, senha: 'fraca' })).rejects.toBeInstanceOf(
      ErroDeUsuario,
    );
    await expect(service.criar({ email: EMAIL, senha: 'fraca' })).rejects.toMatchObject({
      codigo: 'politica',
    });
  });

  it('rejeita senha que contém o local-part do e-mail', async () => {
    // local-part 'novo' embutido: barrado pela regra dependente de contexto do domínio.
    await expect(service.criar({ email: EMAIL, senha: 'novoS3nh@Forte!' })).rejects.toMatchObject({
      codigo: 'politica',
    });
  });
});

describe('ciclo de status', () => {
  it('bloquear define status e revoga as sessões do alvo', async () => {
    const usuario = await service.criar({ email: EMAIL, senha: SENHA });
    const bloqueado = await service.bloquear(usuario.id);
    expect(bloqueado.status).toBe('blocked');
    expect(sessoes.revogados).toContain(usuario.id);
  });

  it('bloquear é idempotente e revoga de novo (fecha corrida de sessão nova)', async () => {
    const usuario = await service.criar({ email: EMAIL, senha: SENHA });
    await service.bloquear(usuario.id);
    await service.bloquear(usuario.id);
    expect(sessoes.revogados.filter((id) => id === usuario.id)).toHaveLength(2);
  });

  it('desbloquear volta o status para active sem revogar', async () => {
    const usuario = await service.criar({ email: EMAIL, senha: SENHA });
    await service.bloquear(usuario.id);
    const ativo = await service.desbloquear(usuario.id);
    expect(ativo.status).toBe('active');
  });

  it('bloquear id inexistente ⇒ nao-encontrado', async () => {
    await expect(service.bloquear('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      codigo: 'nao-encontrado',
    });
  });
});

describe('remover', () => {
  it('revoga as sessões antes de apagar', async () => {
    const usuario = await service.criar({ email: EMAIL, senha: SENHA });
    await service.remover(usuario.id);
    expect(sessoes.revogados).toContain(usuario.id);
    await expect(service.obter(usuario.id)).rejects.toMatchObject({ codigo: 'nao-encontrado' });
  });

  it('remover id inexistente ⇒ nao-encontrado', async () => {
    await expect(service.remover('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      codigo: 'nao-encontrado',
    });
  });
});

describe('leitura', () => {
  it('obter inexistente ⇒ nao-encontrado', async () => {
    await expect(service.obter('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      codigo: 'nao-encontrado',
    });
  });

  it('listar devolve itens e total, respeitando o filtro de status', async () => {
    await service.criar({ email: 'a@iam.local', senha: SENHA });
    const b = await service.criar({ email: 'b@iam.local', senha: SENHA });
    await service.bloquear(b.id);

    const ativos = await service.listar({ limite: 20, offset: 0, status: 'active' });
    expect(ativos.total).toBe(1);
    expect(ativos.items).toHaveLength(1);
    expect(ativos.items[0]?.email).toBe('a@iam.local');

    const todos = await service.listar({ limite: 20, offset: 0 });
    expect(todos.total).toBe(2);
  });

  it('atualizarEmail de id inexistente ⇒ nao-encontrado', async () => {
    await expect(
      service.atualizarEmail('00000000-0000-0000-0000-000000000000', 'x@iam.local'),
    ).rejects.toMatchObject({ codigo: 'nao-encontrado' });
  });
});
