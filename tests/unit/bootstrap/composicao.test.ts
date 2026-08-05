/**
 * Cobre o composition root: os grupos que ele devolve, a identidade dos serviços
 * compartilhados (nada construído duas vezes) e a autorização das rotas de usuário.
 *
 * Sem banco: repositórios só guardam a conexão que recebem, então conexões falsas bastam
 * para provar a fiação — que é tudo o que este módulo faz.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { carregarEnv, type Env } from '../../../src/config/env.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { construirModulos } from '../../../src/bootstrap/composicao.js';
import type { JwksService, RepositorioJwks } from '../../../src/modules/jwks/index.js';

vi.mock('../../../src/shared/crypto/password.service.js', async (importarOriginal) => {
  const original =
    await importarOriginal<typeof import('../../../src/shared/crypto/password.service.js')>();
  return { ...original, criarServicoDeSenhaDaEnv: vi.fn(original.criarServicoDeSenhaDaEnv) };
});

vi.mock(
  '../../../src/modules/rbac/repositories/assignment.repository.js',
  async (importarOriginal) => {
    const original =
      await importarOriginal<
        typeof import('../../../src/modules/rbac/repositories/assignment.repository.js')
      >();
    return {
      ...original,
      criarRepositorioDeAssociacao: vi.fn(original.criarRepositorioDeAssociacao),
    };
  },
);

vi.mock(
  '../../../src/modules/auth/repositories/auth-user.repository.js',
  async (importarOriginal) => {
    const original =
      await importarOriginal<
        typeof import('../../../src/modules/auth/repositories/auth-user.repository.js')
      >();
    return {
      ...original,
      criarRepositorioDeAutenticacao: vi.fn(original.criarRepositorioDeAutenticacao),
    };
  },
);

const { criarServicoDeSenhaDaEnv } = await import('../../../src/shared/crypto/password.service.js');
const { criarRepositorioDeAssociacao } =
  await import('../../../src/modules/rbac/repositories/assignment.repository.js');
const { criarRepositorioDeAutenticacao } =
  await import('../../../src/modules/auth/repositories/auth-user.repository.js');

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

function envDeTeste(sobrescritas: Record<string, string> = {}): Env {
  return carregarEnv({
    POSTGRES_URL: 'postgres://localhost:5432/iam',
    MONGODB_URL: 'mongodb://localhost:27017',
    MASTER_KEY: MASTER,
    ...sobrescritas,
  });
}

/** Linha de `users` que o pool falso devolve — o suficiente para o serviço não abortar. */
function linhaDeUsuario(): Record<string, unknown> {
  return {
    id: 'u1',
    email: 'admin@iam.local',
    status: 'blocked',
    password_hash: 'scrypt$x',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Conexões e serviços falsos: nenhum é tocado durante a construção. */
function conexoesFalsas(): {
  pool: Pool;
  banco: Db;
  jwks: JwksService;
  repoJwks: RepositorioJwks;
} {
  return {
    pool: { query: vi.fn(() => Promise.resolve({ rows: [linhaDeUsuario()] })) } as unknown as Pool,
    banco: { collection: vi.fn(() => ({})) } as unknown as Db,
    jwks: {
      iniciar: vi.fn(),
      invalidar: vi.fn(),
      obterConjuntoDeVerificacao: vi.fn(),
    } as unknown as JwksService,
    repoJwks: {} as RepositorioJwks,
  };
}

function montar(env: Env = envDeTeste()): ReturnType<typeof construirModulos> {
  return construirModulos({
    env,
    ...conexoesFalsas(),
    logger: criarLogger({ nivel: 'fatal' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('construirModulos — grupos devolvidos', () => {
  it('devolve os serviços de todos os módulos com rota', () => {
    const modulos = montar();

    expect(modulos.auth.authService).toBeDefined();
    expect(modulos.refresh.refreshTokenService).toBeDefined();
    expect(modulos.senha.passwordService).toBeDefined();
    expect(modulos.users.userService).toBeDefined();
    expect(modulos.rbac.rbacService).toBeDefined();
    expect(modulos.rbac.assignmentService).toBeDefined();
    expect(modulos.abac.abacService).toBeDefined();
    expect(modulos.clientes.service).toBeDefined();
    expect(modulos.chaves?.rotacao).toBeDefined();
  });

  // Sem o segredo mestre não há como cifrar a privada da chave nova: o serviço de rotação
  // não existe, e as rotas administrativas de chave não têm o que servir.
  it('omite o grupo de chaves quando não há MASTER_KEY', () => {
    const env = carregarEnv({
      POSTGRES_URL: 'postgres://localhost:5432/iam',
      MONGODB_URL: 'mongodb://localhost:27017',
    });

    expect(montar(env).chaves).toBeUndefined();
  });
});

describe('construirModulos — serviços compartilhados', () => {
  it('o verificador de access token é a MESMA instância em auth, rbac, abac e clientes', () => {
    const modulos = montar();

    expect(modulos.rbac.verificarAccessToken).toBe(modulos.auth.verificarAccessToken);
    expect(modulos.abac.verificarAccessToken).toBe(modulos.auth.verificarAccessToken);
    expect(modulos.clientes.verificarAccessToken).toBe(modulos.auth.verificarAccessToken);
    expect(modulos.chaves?.verificarAccessToken).toBe(modulos.auth.verificarAccessToken);
  });

  it('os guards de autorização são os mesmos em rbac, abac, clientes e chaves', () => {
    const modulos = montar();

    expect(modulos.abac.guards).toBe(modulos.rbac.guards);
    expect(modulos.clientes.guards).toBe(modulos.rbac.guards);
    expect(modulos.chaves?.guards).toBe(modulos.rbac.guards);
  });

  it('o serviço de senha é construído uma vez só, para senha e usuários', () => {
    montar();

    expect(criarServicoDeSenhaDaEnv).toHaveBeenCalledTimes(1);
  });

  it('o repositório de associação é construído uma vez, para rbacService e assignmentService', () => {
    montar();

    expect(criarRepositorioDeAssociacao).toHaveBeenCalledTimes(1);
  });

  it('o repositório de autenticação é construído uma vez, para auth e refresh', () => {
    montar();

    expect(criarRepositorioDeAutenticacao).toHaveBeenCalledTimes(1);
  });
});

describe('construirModulos — autorização das rotas de usuário', () => {
  const autorizadorDe = (): ReturnType<typeof construirModulos>['users']['autorizador'] =>
    montar().users.autorizador;

  function requisicaoCom(usuario?: { id: string; permissions: string[] }): FastifyRequest {
    return { usuario } as unknown as FastifyRequest;
  }

  it('recusa por falta de token quando nada autenticou a requisição', () => {
    expect(autorizadorDe()(requisicaoCom())).toEqual({ ok: false, motivo: 'sem-token' });
  });

  it('recusa por falta de permissão quando o token não traz a de administração', () => {
    const resultado = autorizadorDe()(requisicaoCom({ id: 'u1', permissions: ['roles:read'] }));

    expect(resultado).toEqual({ ok: false, motivo: 'sem-permissao' });
  });

  it('autoriza com a permissão exata e devolve o id do administrador', () => {
    const resultado = autorizadorDe()(requisicaoCom({ id: 'u1', permissions: ['users:write'] }));

    expect(resultado).toEqual({ ok: true, adminId: 'u1' });
  });

  it('autoriza o superadmin pelo curinga', () => {
    const resultado = autorizadorDe()(requisicaoCom({ id: 'root', permissions: ['*'] }));

    expect(resultado).toEqual({ ok: true, adminId: 'root' });
  });
});

describe('construirModulos — revogação de sessões', () => {
  it('a revogação chamada pelo bloqueio derruba os refresh tokens do usuário', async () => {
    // O repositório lê `modifiedCount` da resposta: quem revoga de fora precisa saber
    // quantas sessões caíram, então o driver falso precisa devolver o resultado real.
    const updateMany = vi.fn(() => Promise.resolve({ modifiedCount: 2 }));
    const banco = { collection: vi.fn(() => ({ updateMany })) } as unknown as Db;
    const { pool, jwks, repoJwks } = conexoesFalsas();
    const modulos = construirModulos({
      env: envDeTeste(),
      pool,
      banco,
      jwks,
      repoJwks,
      logger: criarLogger({ nivel: 'fatal' }),
    });

    await modulos.users.userService.bloquear('u1');

    expect(updateMany).toHaveBeenCalledWith(
      { user_id: 'u1', status: 'active' },
      { $set: { status: 'revoked' } },
    );
  });
});

describe('construirModulos — medidores de telemetria', () => {
  // Com telemetria ligada, cada serviço recebe seu medidor. O risco aqui não é o número que
  // sai, é a construção quebrar no boot de um ambiente que tem métricas e outro não.
  it('constrói todos os serviços com os medidores ligados', () => {
    const modulos = construirModulos({
      env: envDeTeste(),
      ...conexoesFalsas(),
      logger: criarLogger({ nivel: 'fatal' }),
      metricas: true,
    });

    expect(modulos.auth.authService).toBeDefined();
    expect(modulos.refresh.refreshTokenService).toBeDefined();
    expect(modulos.clientes.service).toBeDefined();
    expect(modulos.chaves?.rotacao).toBeDefined();
    expect(modulos.users.medidor).toBeDefined();
  });
});
