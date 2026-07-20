/**
 * Cobre o PasswordService com todas as portas em fake: os fluxos felizes e cada ramo de
 * erro, mais as garantias de segurança — anti-enumeration no forgot, uso único no reset,
 * revogação de sessões na troca.
 *
 * Custo de scrypt reduzido (N=2^14) para a suíte não pagar o custo de produção.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { criarServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import {
  criarPasswordService,
  type PasswordService,
} from '../../../../src/modules/password/services/password.service.js';
import { ErroDeSenha } from '../../../../src/modules/password/errors/password-error.js';
import {
  criarCanalDeNotificacaoFake,
  criarHistoricoFake,
  criarRepositorioDeUsuarioFake,
  criarRevogadorDeSessoesFake,
  criarTokensDeResetFake,
  type CanalDeNotificacaoFake,
  type RepositorioDeUsuarioFake,
  type RevogadorDeSessoesFake,
} from '../../../mocks/senha.js';

const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
const SENHA_ATUAL = 'S3nh@Atual!23';
const SENHA_NOVA = 'N0v@Senh@Forte!';

let usuarios: RepositorioDeUsuarioFake;
let sessoes: RevogadorDeSessoesFake;
let notificacao: CanalDeNotificacaoFake;
let tokensDeReset: ReturnType<typeof criarTokensDeResetFake>;
let historico: ReturnType<typeof criarHistoricoFake>;
let service: PasswordService;

/** Semeia um usuário ativo com a SENHA_ATUAL já hasheada. */
async function semearUsuario(status: 'active' | 'blocked' = 'active'): Promise<string> {
  const hash = await servicoDeSenha.gerarHash(SENHA_ATUAL);
  usuarios.semear({ id: 'u1', email: 'user@iam.local', status, passwordHash: hash });
  return hash;
}

beforeEach(() => {
  usuarios = criarRepositorioDeUsuarioFake();
  sessoes = criarRevogadorDeSessoesFake();
  notificacao = criarCanalDeNotificacaoFake();
  tokensDeReset = criarTokensDeResetFake();
  historico = criarHistoricoFake();
  service = criarPasswordService({
    servicoDeSenha,
    usuarios,
    tokensDeReset,
    historico,
    sessoes,
    notificacao,
    ttlResetMin: 30,
    historicoN: 3,
  });
});

/** Captura o `codigo` de um ErroDeSenha lançado por `fn`. */
async function capturarCodigo(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (erro) {
    if (erro instanceof ErroDeSenha) return erro.codigo;
    throw erro;
  }
  throw new Error('esperava ErroDeSenha, nada foi lançado');
}

describe('trocar', () => {
  it('troca a senha, grava o novo hash e revoga as sessões', async () => {
    await semearUsuario();

    await service.trocar({ userId: 'u1', senhaAtual: SENHA_ATUAL, senhaNova: SENHA_NOVA });

    const novoHash = usuarios.hashAtual('u1');
    expect(await servicoDeSenha.verificar(SENHA_NOVA, novoHash ?? '')).toBe(true);
    expect(sessoes.revogados).toEqual(['u1']);
  });

  it('senha atual errada ⇒ credencial-invalida', async () => {
    await semearUsuario();

    expect(
      await capturarCodigo(() =>
        service.trocar({ userId: 'u1', senhaAtual: 'errada', senhaNova: SENHA_NOVA }),
      ),
    ).toBe('credencial-invalida');
    expect(sessoes.revogados).toEqual([]);
  });

  it('nova senha fraca ⇒ politica', async () => {
    await semearUsuario();

    expect(
      await capturarCodigo(() =>
        service.trocar({ userId: 'u1', senhaAtual: SENHA_ATUAL, senhaNova: 'fraca' }),
      ),
    ).toBe('politica');
  });

  it('nova senha igual à atual ⇒ reuso', async () => {
    await semearUsuario();

    expect(
      await capturarCodigo(() =>
        service.trocar({ userId: 'u1', senhaAtual: SENHA_ATUAL, senhaNova: SENHA_ATUAL }),
      ),
    ).toBe('reuso');
  });

  it('nova senha igual a uma das últimas N ⇒ reuso', async () => {
    await semearUsuario();
    // Troca uma vez para SENHA_NOVA (entra no histórico), depois tenta voltar a ela.
    await service.trocar({ userId: 'u1', senhaAtual: SENHA_ATUAL, senhaNova: SENHA_NOVA });

    const atual = usuarios.hashAtual('u1');
    expect(atual).toBeDefined();
    const senhaIntermediaria = 'Interm3di@ria!';
    await service.trocar({ userId: 'u1', senhaAtual: SENHA_NOVA, senhaNova: senhaIntermediaria });

    expect(
      await capturarCodigo(() =>
        service.trocar({ userId: 'u1', senhaAtual: senhaIntermediaria, senhaNova: SENHA_NOVA }),
      ),
    ).toBe('reuso');
  });
});

describe('solicitarReset (forgot)', () => {
  it('e-mail existente e ativo ⇒ gera token e entrega pelo canal', async () => {
    await semearUsuario();

    await service.solicitarReset({ email: 'user@iam.local' });

    expect(notificacao.enviados).toHaveLength(1);
    expect(notificacao.enviados[0]?.email).toBe('user@iam.local');
    expect(notificacao.enviados[0]?.token).toMatch(/^[\w-]{43}$/);
  });

  it('e-mail inexistente ⇒ não gera token e não lança (anti-enumeration)', async () => {
    await expect(service.solicitarReset({ email: 'ninguem@iam.local' })).resolves.toBeUndefined();
    expect(notificacao.enviados).toEqual([]);
  });

  it('usuário bloqueado ⇒ não gera token', async () => {
    await semearUsuario('blocked');

    await service.solicitarReset({ email: 'user@iam.local' });

    expect(notificacao.enviados).toEqual([]);
  });
});

describe('confirmarReset', () => {
  async function tokenParaReset(): Promise<string> {
    await semearUsuario();
    await service.solicitarReset({ email: 'user@iam.local' });
    const token = notificacao.enviados[0]?.token;
    if (token === undefined) throw new Error('sem token');
    return token;
  }

  it('token válido + senha forte ⇒ aplica e revoga sessões', async () => {
    const token = await tokenParaReset();

    await service.confirmarReset({ token, senhaNova: SENHA_NOVA });

    expect(await servicoDeSenha.verificar(SENHA_NOVA, usuarios.hashAtual('u1') ?? '')).toBe(true);
    expect(sessoes.revogados).toEqual(['u1']);
  });

  it('token usado duas vezes ⇒ segunda vez token-invalido', async () => {
    const token = await tokenParaReset();
    await service.confirmarReset({ token, senhaNova: SENHA_NOVA });

    expect(
      await capturarCodigo(() => service.confirmarReset({ token, senhaNova: 'Outr@Senh@123!' })),
    ).toBe('token-invalido');
  });

  it('token inexistente ⇒ token-invalido', async () => {
    await semearUsuario();

    expect(
      await capturarCodigo(() =>
        service.confirmarReset({ token: 'inexistente', senhaNova: SENHA_NOVA }),
      ),
    ).toBe('token-invalido');
  });

  it('senha fraca ⇒ politica, e o token NÃO é queimado', async () => {
    const token = await tokenParaReset();

    expect(await capturarCodigo(() => service.confirmarReset({ token, senhaNova: 'fraca' }))).toBe(
      'politica',
    );

    // O token sobrevive à senha reprovada: um retry com senha forte funciona.
    await expect(service.confirmarReset({ token, senhaNova: SENHA_NOVA })).resolves.toBeUndefined();
  });
});
