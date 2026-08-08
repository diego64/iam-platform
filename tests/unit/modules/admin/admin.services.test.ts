/**
 * Cobre os três serviços do painel: visão agregada, ficha do usuário e sessões de terceiros.
 *
 * As propriedades que importam aqui não são os números, e sim o comportamento em volta deles:
 * o cache não consulta os bancos dentro da janela, fonte acessória caída degrada em vez de
 * derrubar, fonte essencial caída derruba mesmo, e nenhum campo sensível tem caminho até a
 * ficha.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { criarOverviewService } from '../../../../src/modules/admin/services/overview.service.js';
import { criarUserViewService } from '../../../../src/modules/admin/services/user-view.service.js';
import { criarAdminSessionsService } from '../../../../src/modules/admin/services/admin-sessions.service.js';
import { ErroDeAdmin } from '../../../../src/modules/admin/errors/admin.errors.js';
import { criarRegistradorFake, type RegistradorFake } from '../../../mocks/auditoria.js';
import type {
  LeitorDeAuditoria,
  LeitorDeAutorizacao,
  LeitorDeChaveAtiva,
  LeitorDeClientes,
  LeitorDeSenha,
  LeitorDeSessoes,
  LeitorDeUsuarios,
  PerfilDeUsuario,
  RevogadorDeSessoesDeTerceiro,
} from '../../../../src/modules/admin/interfaces/portas.js';

const PERFIL: PerfilDeUsuario = {
  id: 'u1',
  email: 'ana@iam.local',
  status: 'active',
  criadoEm: new Date('2026-01-10T09:00:00.000Z'),
  atualizadoEm: new Date('2026-07-30T18:20:00.000Z'),
};

function usuariosFake(sobrescritas: Partial<LeitorDeUsuarios> = {}): LeitorDeUsuarios {
  return {
    contarPorStatus: () => Promise.resolve({ active: 128, blocked: 4 }),
    buscarPorId: () => Promise.resolve(PERFIL),
    ...sobrescritas,
  };
}

function sessoesFake(sobrescritas: Partial<LeitorDeSessoes> = {}): LeitorDeSessoes {
  return {
    contarAtivas: () => Promise.resolve(87),
    listarDoUsuario: () =>
      Promise.resolve([
        {
          sessionId: 's1',
          criadaEm: new Date('2026-08-03T08:00:00.000Z'),
          expiraEm: new Date('2026-08-10T08:00:00.000Z'),
        },
      ]),
    ...sobrescritas,
  };
}

function auditoriaFake(sobrescritas: Partial<LeitorDeAuditoria> = {}): LeitorDeAuditoria {
  return {
    contarPorTipoDesde: (tipo) => Promise.resolve(tipo === 'iam.auth.login' ? 340 : 12),
    ultimosDoUsuario: () =>
      Promise.resolve([
        { seq: 1042, type: 'iam.auth.login', occurredAt: new Date(), outcome: 'success' },
      ]),
    ...sobrescritas,
  };
}

const clientesFake: LeitorDeClientes = { contarAtivos: () => Promise.resolve(6) };
const chavesFake: LeitorDeChaveAtiva = {
  obter: () => Promise.resolve({ kid: 'kid-1', criadaEm: new Date('2026-07-31T12:00:00.000Z') }),
};

const AGORA = new Date('2026-08-03T12:00:00.000Z').getTime();

function overview(opcoes: {
  usuarios?: LeitorDeUsuarios;
  sessoes?: LeitorDeSessoes;
  auditoria?: LeitorDeAuditoria;
  clientes?: LeitorDeClientes;
  chaves?: LeitorDeChaveAtiva;
  janelaMs?: number;
  agora?: () => number;
}): ReturnType<typeof criarOverviewService> {
  return criarOverviewService({
    usuarios: opcoes.usuarios ?? usuariosFake(),
    sessoes: opcoes.sessoes ?? sessoesFake(),
    auditoria: opcoes.auditoria ?? auditoriaFake(),
    clientes: opcoes.clientes ?? clientesFake,
    chaves: opcoes.chaves ?? chavesFake,
    janelaDeCacheMs: opcoes.janelaMs ?? 30_000,
    agora: opcoes.agora ?? ((): number => AGORA),
  });
}

describe('visão agregada', () => {
  it('reúne os números das cinco fontes', async () => {
    const { visao, doCache } = await overview({}).obter();

    expect(doCache).toBe(false);
    expect(visao.parcial).toBe(false);
    expect(visao.usuarios).toEqual({ active: 128, blocked: 4, total: 132 });
    expect(visao.sessoesAtivas).toBe(87);
    expect(visao.logins24h).toEqual({ sucesso: 340, falha: 12 });
    expect(visao.clientesAtivos).toBe(6);
    expect(visao.chaveAtiva).toEqual({ kid: 'kid-1', idadeDias: 3 });
  });

  it('não consulta fonte nenhuma dentro da janela do cache', async () => {
    const contar = vi.fn(() => Promise.resolve({ active: 1, blocked: 0 }));
    const servico = overview({ usuarios: usuariosFake({ contarPorStatus: contar }) });

    const primeira = await servico.obter();
    const segunda = await servico.obter();

    expect(contar).toHaveBeenCalledTimes(1);
    expect(segunda.doCache).toBe(true);
    expect(segunda.visao.apuradoEm).toEqual(primeira.visao.apuradoEm);
  });

  it('reapura depois que a janela vence', async () => {
    const contar = vi.fn(() => Promise.resolve({ active: 1, blocked: 0 }));
    let relogio = AGORA;
    const servico = overview({
      usuarios: usuariosFake({ contarPorStatus: contar }),
      janelaMs: 1_000,
      agora: () => relogio,
    });

    await servico.obter();
    relogio += 1_001;
    const depois = await servico.obter();

    expect(contar).toHaveBeenCalledTimes(2);
    expect(depois.doCache).toBe(false);
  });

  it('janela zero desliga o cache', async () => {
    const contar = vi.fn(() => Promise.resolve({ active: 1, blocked: 0 }));
    const servico = overview({ usuarios: usuariosFake({ contarPorStatus: contar }), janelaMs: 0 });

    await servico.obter();
    await servico.obter();

    expect(contar).toHaveBeenCalledTimes(2);
  });

  it('degrada a fonte acessória que falha, sem derrubar a visão', async () => {
    const { visao } = await overview({
      sessoes: sessoesFake({ contarAtivas: () => Promise.reject(new Error('mongo fora')) }),
    }).obter();

    expect(visao.parcial).toBe(true);
    expect(visao.sessoesAtivas).toBeNull();
    expect(visao.usuarios.total).toBe(132);
  });

  it('anula os dois contadores de login juntos: um sem o outro seria taxa inventada', async () => {
    const { visao } = await overview({
      auditoria: auditoriaFake({
        contarPorTipoDesde: (tipo) =>
          tipo === 'iam.auth.login_failed'
            ? Promise.reject(new Error('trilha fora'))
            : Promise.resolve(340),
      }),
    }).obter();

    expect(visao.logins24h).toBeNull();
    expect(visao.parcial).toBe(true);
  });

  it('falha inteira quando a contagem de usuários cai — não é campo faltando', async () => {
    const servico = overview({
      usuarios: usuariosFake({ contarPorStatus: () => Promise.reject(new Error('pg fora')) }),
    });

    await expect(servico.obter()).rejects.toBeInstanceOf(ErroDeAdmin);
  });
});

describe('ficha do usuário', () => {
  const senhaFake: LeitorDeSenha = {
    alteradaEm: () => Promise.resolve(new Date('2026-06-01T10:00:00.000Z')),
  };
  const autorizacaoFake: LeitorDeAutorizacao = {
    papeisDoUsuario: () => Promise.resolve([{ id: 'r1', name: 'operador', isSystem: false }]),
    permissoesEfetivas: () => Promise.resolve(['users:read']),
  };

  function ficha(sobrescritas: {
    usuarios?: LeitorDeUsuarios;
    autorizacao?: LeitorDeAutorizacao;
    sessoes?: LeitorDeSessoes;
    auditoria?: LeitorDeAuditoria;
    senha?: LeitorDeSenha;
  }): ReturnType<typeof criarUserViewService> {
    return criarUserViewService({
      usuarios: sobrescritas.usuarios ?? usuariosFake(),
      autorizacao: sobrescritas.autorizacao ?? autorizacaoFake,
      sessoes: sobrescritas.sessoes ?? sessoesFake(),
      auditoria: sobrescritas.auditoria ?? auditoriaFake(),
      senha: sobrescritas.senha ?? senhaFake,
      limiteDeEventos: 10,
    });
  }

  it('agrega perfil, papéis, permissões, senha, sessões e eventos', async () => {
    const resultado = await ficha({}).obter('u1');

    expect(resultado.parcial).toBe(false);
    expect(resultado.perfil.email).toBe('ana@iam.local');
    expect(resultado.papeis).toHaveLength(1);
    expect(resultado.permissoes).toEqual(['users:read']);
    expect(resultado.sessoes).toHaveLength(1);
    expect(resultado.eventos).toHaveLength(1);
    expect(resultado.senha?.alteradaEm).toBeInstanceOf(Date);
  });

  it('não deixa campo sensível chegar à ficha', async () => {
    const resultado = await ficha({}).obter('u1');

    const serializada = JSON.stringify(resultado).toLowerCase();
    for (const proibida of ['passwordhash', 'password_hash', 'token_hash', 'secret', 'private']) {
      expect(serializada).not.toContain(proibida);
    }
  });

  it('recusa antes de agregar quando o usuário não existe', async () => {
    const listar = vi.fn(() => Promise.resolve([]));
    const servico = ficha({
      usuarios: usuariosFake({ buscarPorId: () => Promise.resolve(null) }),
      sessoes: sessoesFake({ listarDoUsuario: listar }),
    });

    await expect(servico.obter('sumido')).rejects.toMatchObject({
      codigo: 'usuario-nao-encontrado',
    });
    expect(listar).not.toHaveBeenCalled();
  });

  it('degrada a trilha indisponível para eventos nulos, mantendo o resto', async () => {
    const resultado = await ficha({
      auditoria: auditoriaFake({
        ultimosDoUsuario: () => Promise.reject(new Error('trilha fora')),
      }),
    }).obter('u1');

    expect(resultado.eventos).toBeNull();
    expect(resultado.parcial).toBe(true);
    expect(resultado.perfil.id).toBe('u1');
  });

  it('respeita o limite de eventos ao consultar a trilha', async () => {
    const ultimos = vi.fn(() => Promise.resolve([]));
    await ficha({ auditoria: auditoriaFake({ ultimosDoUsuario: ultimos }) }).obter('u1');

    expect(ultimos).toHaveBeenCalledWith('u1', 10);
  });
});

describe('sessões de terceiros', () => {
  let auditoria: RegistradorFake;

  function servico(
    revogador: Partial<RevogadorDeSessoesDeTerceiro> = {},
  ): ReturnType<typeof criarAdminSessionsService> {
    return criarAdminSessionsService({
      usuarios: usuariosFake(),
      sessoes: sessoesFake(),
      revogador: {
        revogarUma: () => Promise.resolve(true),
        revogarTodas: () => Promise.resolve(3),
        ...revogador,
      },
      auditoria,
    });
  }

  beforeEach(() => {
    auditoria = criarRegistradorFake();
  });

  it('lista as sessões de outro usuário', async () => {
    expect(await servico().listar('u1')).toHaveLength(1);
  });

  it('recusa o administrador que aponta para a própria sessão', async () => {
    await expect(servico().revogarUma('u1', 'u1', 's1')).rejects.toMatchObject({
      codigo: 'sessao-propria',
    });
    await expect(servico().revogarTodas('u1', 'u1')).rejects.toMatchObject({
      codigo: 'sessao-propria',
    });
  });

  it('recusa alvo inexistente', async () => {
    const comSumido = criarAdminSessionsService({
      usuarios: usuariosFake({ buscarPorId: () => Promise.resolve(null) }),
      sessoes: sessoesFake(),
      revogador: {
        revogarUma: () => Promise.resolve(true),
        revogarTodas: () => Promise.resolve(0),
      },
      auditoria,
    });

    await expect(comSumido.revogarUma('admin', 'sumido', 's1')).rejects.toMatchObject({
      codigo: 'usuario-nao-encontrado',
    });
  });

  it('trata sessão inexistente ou de outro dono como não encontrada', async () => {
    await expect(
      servico({ revogarUma: () => Promise.resolve(false) }).revogarUma('admin', 'u1', 's9'),
    ).rejects.toMatchObject({ codigo: 'sessao-nao-encontrada' });
  });

  it('registra a revogação de uma sessão com ator, alvo e alcance', async () => {
    await servico().revogarUma('admin', 'u1', 's1');

    const evento = auditoria.doTipo('iam.session.revoked');
    expect(evento?.actor.id).toBe('admin');
    expect(evento?.target).toEqual({ id: 'u1', type: 'user' });
    expect(evento?.metadata).toEqual({ escopo: 's1', revogadas: 1 });
  });

  it('devolve quantas sessões caíram na revogação em massa e registra o total', async () => {
    const revogadas = await servico().revogarTodas('admin', 'u1');

    expect(revogadas).toBe(3);
    expect(auditoria.doTipo('iam.session.revoked')?.metadata).toEqual({
      escopo: 'todas',
      revogadas: 3,
    });
  });

  it('não registra evento quando a revogação é recusada', async () => {
    await expect(
      servico({ revogarUma: () => Promise.resolve(false) }).revogarUma('admin', 'u1', 's9'),
    ).rejects.toThrow();

    expect(auditoria.eventos).toEqual([]);
  });
});
