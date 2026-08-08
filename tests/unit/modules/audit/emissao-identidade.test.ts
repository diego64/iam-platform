/**
 * Cobre a emissão de eventos pelos serviços de identidade: autenticação, ciclo de vida do
 * usuário e senha.
 *
 * O que se afirma aqui não é o formato do documento — isso é do serviço de auditoria — e sim
 * que cada operação sensível **emite**, com o tipo certo, o alvo certo e sem o e-mail de quem
 * não é usuário. Operação sensível que não emite é o modo de falha que ninguém percebe: a
 * trilha fica coerente, íntegra e incompleta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { criarAuthService } from '../../../../src/modules/auth/services/auth.service.js';
import { criarUserService } from '../../../../src/modules/users/services/user.service.js';
import { criarPasswordService } from '../../../../src/modules/password/services/password.service.js';
import { criarServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import type { ServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import type { RepositorioDeAutenticacao } from '../../../../src/modules/auth/repositories/auth-user.repository.js';
import type { StatusDeUsuario } from '../../../../src/modules/users/entities/user.entity.js';
import { criarRegistradorFake, type RegistradorFake } from '../../../mocks/auditoria.js';
import {
  criarRepositorioDeUsuarioFake,
  criarRevogadorDeSessoesFake,
  type RepositorioDeUsuarioFake,
  type RevogadorDeSessoesFake,
} from '../../../mocks/usuarios.js';
import {
  criarCanalDeNotificacaoFake,
  criarHistoricoFake,
  criarRepositorioDeUsuarioFake as criarUsuariosDeSenhaFake,
  criarTokensDeResetFake,
  type RepositorioDeUsuarioFake as UsuariosDeSenhaFake,
} from '../../../mocks/senha.js';

const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
const SENHA_CERTA = 'correta';
const EMAIL = 'ana@iam.local';

let auditoria: RegistradorFake;

beforeEach(() => {
  auditoria = criarRegistradorFake();
});

// ---------- Autenticação ----------

function senhaFake(): ServicoDeSenha {
  return {
    gerarHash: () => Promise.resolve(HASH),
    verificar: (senha: string, hash: string) =>
      Promise.resolve(senha === SENHA_CERTA && hash === HASH),
    precisaRehash: () => false,
    hashFantasma: () => Promise.resolve('scrypt$16384$8$1$Zg==$Zg=='),
  };
}

function repoAuthFake(status: StatusDeUsuario | null): RepositorioDeAutenticacao {
  const usuario = status === null ? null : { id: 'u1', email: EMAIL, status, passwordHash: HASH };
  return {
    buscarPorEmail: () => Promise.resolve(usuario),
    buscarPorId: () =>
      Promise.resolve(usuario === null ? null : { id: 'u1', email: EMAIL, status: usuario.status }),
    papeisDoUsuario: () => Promise.resolve([]),
    permissoesEfetivas: () => Promise.resolve([]),
  };
}

function authComStatus(status: StatusDeUsuario | null): ReturnType<typeof criarAuthService> {
  return criarAuthService({
    repo: repoAuthFake(status),
    servicoDeSenha: senhaFake(),
    tokenService: {
      emitir: () =>
        Promise.resolve({ token: 'jwt', jti: 'j1', expiraEm: new Date(), ttlSegundos: 900 }),
    },
    refreshToken: { emitir: () => Promise.resolve('opaco'), revogar: () => Promise.resolve() },
    denylist: { revogar: () => Promise.resolve(), estaRevogado: () => Promise.resolve(false) },
    auditoria,
  });
}

describe('autenticação', () => {
  it('login bem-sucedido registra o evento com o usuário como ator', async () => {
    await authComStatus('active').login({ email: EMAIL, senha: SENHA_CERTA });

    expect(auditoria.tipos()).toEqual(['iam.auth.login']);
    expect(auditoria.doTipo('iam.auth.login')?.actor.id).toBe('u1');
    expect(auditoria.doTipo('iam.auth.login')?.outcome).toBe('success');
  });

  it('conta inexistente registra falha sem ator e sem gravar o e-mail digitado', async () => {
    await expect(
      authComStatus(null).login({ email: 'ninguem@iam.local', senha: 'x' }),
    ).rejects.toThrow();

    const evento = auditoria.doTipo('iam.auth.login_failed');
    expect(evento?.actor.id).toBeNull();
    expect(evento?.reason).toBe('invalid_credentials');
    // O e-mail vai como sujeito, e é o serviço de auditoria que o converte em pista antes
    // de qualquer escrita — nunca chega à trilha em claro.
    expect(evento?.subjectEmail).toBe('ninguem@iam.local');
    expect(JSON.stringify(evento?.metadata ?? {})).not.toContain('ninguem@iam.local');
  });

  it('senha errada registra falha já com o usuário identificado', async () => {
    await expect(
      authComStatus('active').login({ email: EMAIL, senha: 'errada' }),
    ).rejects.toThrow();

    expect(auditoria.doTipo('iam.auth.login_failed')?.actor.id).toBe('u1');
  });

  it('conta bloqueada registra o motivo específico na trilha, não na resposta', async () => {
    await expect(
      authComStatus('blocked').login({ email: EMAIL, senha: SENHA_CERTA }),
    ).rejects.toThrow();

    expect(auditoria.doTipo('iam.auth.login_failed')?.reason).toBe('account_blocked');
  });

  it('logout registra o encerramento da sessão', async () => {
    await authComStatus('active').logout({
      jti: 'j1',
      userId: 'u1',
      expiraEm: new Date(Date.now() + 60_000),
    });

    expect(auditoria.tipos()).toEqual(['iam.auth.logout']);
    expect(auditoria.doTipo('iam.auth.logout')?.actor.id).toBe('u1');
  });
});

// ---------- Ciclo de vida do usuário ----------

describe('ciclo de vida do usuário', () => {
  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
  let repositorio: RepositorioDeUsuarioFake;
  let sessoes: RevogadorDeSessoesFake;
  let service: ReturnType<typeof criarUserService>;

  beforeEach(() => {
    repositorio = criarRepositorioDeUsuarioFake();
    sessoes = criarRevogadorDeSessoesFake();
    service = criarUserService({ repositorio, servicoDeSenha, sessoes, auditoria });
  });

  it('registra criação, alteração, bloqueio, desbloqueio e remoção, sempre com o alvo', async () => {
    const usuario = await service.criar({ email: 'novo@iam.local', senha: 'S3nh@MuitoForte!' });
    await service.atualizarEmail(usuario.id, 'outro@iam.local');
    await service.bloquear(usuario.id);
    await service.desbloquear(usuario.id);
    await service.remover(usuario.id);

    expect(auditoria.tipos()).toEqual([
      'iam.user.created',
      'iam.user.updated',
      'iam.user.blocked',
      'iam.user.unblocked',
      'iam.user.deleted',
    ]);
    for (const evento of auditoria.eventos) {
      expect(evento.target).toEqual({ id: usuario.id, type: 'user' });
    }
  });

  it('deixa o ator nulo para o contexto da requisição preencher', async () => {
    const usuario = await service.criar({ email: 'novo@iam.local', senha: 'S3nh@MuitoForte!' });

    expect(auditoria.doTipo('iam.user.created')?.actor.id).toBeNull();
    expect(usuario.id).toBeDefined();
  });

  it('não registra nada quando a operação falha', async () => {
    await expect(service.bloquear('inexistente')).rejects.toThrow();

    expect(auditoria.eventos).toEqual([]);
  });
});

// ---------- Senha ----------

describe('senha', () => {
  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 });
  const SENHA_ATUAL = 'S3nh@Atual!2026';
  const SENHA_NOVA = 'S3nh@Nova!2026x';

  let usuarios: UsuariosDeSenhaFake;
  let tokensDeReset: ReturnType<typeof criarTokensDeResetFake>;
  let notificacao: ReturnType<typeof criarCanalDeNotificacaoFake>;
  let service: ReturnType<typeof criarPasswordService>;

  beforeEach(async () => {
    usuarios = criarUsuariosDeSenhaFake();
    tokensDeReset = criarTokensDeResetFake();
    notificacao = criarCanalDeNotificacaoFake();
    usuarios.semear({
      id: 'u1',
      email: 'user@iam.local',
      status: 'active',
      passwordHash: await servicoDeSenha.gerarHash(SENHA_ATUAL),
    });
    service = criarPasswordService({
      servicoDeSenha,
      usuarios,
      tokensDeReset,
      historico: criarHistoricoFake(),
      sessoes: criarRevogadorDeSessoesFake(),
      notificacao,
      ttlResetMin: 30,
      historicoN: 3,
      auditoria,
    });
  });

  it('registra a troca de senha do próprio usuário', async () => {
    await service.trocar({ userId: 'u1', senhaAtual: SENHA_ATUAL, senhaNova: SENHA_NOVA });

    expect(auditoria.tipos()).toEqual(['iam.password.changed']);
    expect(auditoria.doTipo('iam.password.changed')?.actor.id).toBe('u1');
  });

  it('registra o pedido de reset apenas quando existe conta ativa por trás', async () => {
    await service.solicitarReset({ email: 'user@iam.local' });
    await service.solicitarReset({ email: 'ninguem@iam.local' });

    expect(auditoria.tipos()).toEqual(['iam.password.reset_requested']);
  });

  it('registra a conclusão do reset', async () => {
    await service.solicitarReset({ email: 'user@iam.local' });
    const token = notificacao.enviados.at(-1)?.token;
    expect(token).toBeDefined();

    await service.confirmarReset({ token: token ?? '', senhaNova: SENHA_NOVA });

    expect(auditoria.tipos()).toEqual([
      'iam.password.reset_requested',
      'iam.password.reset_completed',
    ]);
  });

  it('não registra conclusão quando o token é inválido', async () => {
    await expect(
      service.confirmarReset({ token: 'inexistente', senhaNova: SENHA_NOVA }),
    ).rejects.toThrow();

    expect(auditoria.eventos).toEqual([]);
  });
});
