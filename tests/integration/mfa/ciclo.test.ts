/**
 * Ciclo completo do segundo fator contra o app real e bancos reais.
 *
 * Percurso: login de um passo → cadastro → confirmação → login que agora para no desafio →
 * verificação → tokens com `amr` → desativação. Cobre também o replay do mesmo código, o
 * uso único do desafio, o código de recuperação e o reset administrativo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { montarProblema } from '../../../src/shared/errors/problem-json.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { limparMfa, recriarSchemaDeMfa } from './schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import {
  criarJwksService,
  criarRepositorioJwks,
  garantirChaveDeBootstrap,
} from '../../../src/modules/jwks/index.js';
import {
  criarAuthService,
  criarRepositorioDeAutenticacao,
  criarRepositorioDeDenylist,
  criarTokenService,
  criarVerificadorDeAccessToken,
  idAutenticado,
  registrarRotasDeAuth,
} from '../../../src/modules/auth/index.js';
import {
  criarRefreshTokenService,
  criarRepositorioDeRefreshToken,
  registrarRotasDeRefresh,
} from '../../../src/modules/refresh-token/index.js';
import { criarRepositorioDeUsuario } from '../../../src/modules/users/index.js';
import { criarGuardsDeAutorizacao } from '../../../src/modules/rbac/index.js';
import {
  criarMfaService,
  criarRepositorioDeCodigosDeRecuperacao,
  criarRepositorioDeDesafioDeMfa,
  criarRepositorioDeFatorDeMfa,
  criarServicoDeDesafioDeMfa,
  registrarRotasDeMfa,
} from '../../../src/modules/mfa/index.js';
import { gerarCodigo, passoDe } from '../../../src/modules/mfa/services/totp.js';
import { decodificarBase32 } from '../../../src/modules/mfa/services/base32.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const EMISSOR = 'https://iam.example.com';
const SENHA = 'S3nh@Forte!';
const EMAIL = 'mfa-ciclo@iam.local';
const ADMIN = 'mfa-admin@iam.local';

let pool: Pool;
let mongo: MongoClient;
let banco: Db;
let app: FastifyInstance;
let ip = 0;

interface ParDeTokens {
  access_token: string;
  refresh_token: string;
}

async function logar(email: string): Promise<Record<string, unknown>> {
  ip += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: `10.40.0.${String(ip % 250)}`,
    payload: { email, senha: SENHA },
  });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Código de um passo à frente do atual.
 *
 * A confirmação do cadastro consome o passo corrente, e o anti-replay recusa qualquer passo
 * menor ou igual ao último usado — inclusive o mesmo, dentro dos 30 s em que ele continuaria
 * matematicamente correto. Um passo à frente segue dentro da janela de tolerância.
 */
function codigoSeguinte(segredo: Buffer): string {
  return gerarCodigo(segredo, passoDe(Date.now()) + 1);
}

/** Cadastra e confirma um fator, devolvendo o segredo para gerar códigos nos testes. */
async function habilitarMfa(token: string): Promise<{ segredo: Buffer; codigos: string[] }> {
  const cadastro = await app.inject({
    method: 'POST',
    url: '/auth/mfa/totp',
    headers: bearer(token),
    payload: {},
  });
  expect(cadastro.statusCode).toBe(201);
  const segredo = decodificarBase32(cadastro.json<{ secret: string }>().secret);

  const confirmacao = await app.inject({
    method: 'POST',
    url: '/auth/mfa/totp/confirm',
    headers: bearer(token),
    payload: { code: gerarCodigo(segredo, passoDe(Date.now())) },
  });
  expect(confirmacao.statusCode).toBe(200);
  return { segredo, codigos: confirmacao.json<{ recovery_codes: string[] }>().recovery_codes };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste(), max: 6 });
  await recriarSchemaDeMfa(pool);
  await recriarSchemaJwks(pool);
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await banco.collection('mfa_challenges').deleteMany({});

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register((await import('@fastify/swagger')).default, {
    openapi: { info: { title: 'teste', version: '0' } },
    transform: jsonSchemaTransform,
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  app.setErrorHandler((erro: FastifyError, _req, resposta) => {
    if (hasZodFastifySchemaValidationErrors(erro)) {
      void resposta
        .status(400)
        .type('application/problem+json')
        .send(montarProblema('validation-error', 'Requisição inválida', 400));
      return;
    }
    void resposta
      .status(erro.statusCode ?? 500)
      .type('application/problem+json')
      .send(montarProblema('internal-error', 'Erro interno', 500));
  });

  const logger = criarLogger({ nivel: 'fatal' });
  const repoJwks = criarRepositorioJwks(pool);
  await garantirChaveDeBootstrap({ repo: repoJwks, masterKey: MASTER, logger });
  const jwks = criarJwksService({ repo: repoJwks, masterKey: MASTER, cacheTtlMs: 300_000 });
  await jwks.iniciar();

  const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
  const denylist = criarRepositorioDeDenylist(banco);
  const tokenService = criarTokenService(jwks, {
    emissor: EMISSOR,
    audiencia: 'iam-clients',
    ttlSegundos: 900,
  });
  const repoAuth = criarRepositorioDeAutenticacao(pool);
  const repoRefresh = criarRepositorioDeRefreshToken(banco);
  const refreshTokenService = criarRefreshTokenService({
    repo: repoRefresh,
    usuarios: repoAuth,
    tokenService,
    ttlIdleMs: 60_000,
    ttlAbsolutoMs: 3_600_000,
    graceMs: 0,
  });

  const fatores = criarRepositorioDeFatorDeMfa(pool);
  const codigos = criarRepositorioDeCodigosDeRecuperacao(pool);
  const desafios = criarRepositorioDeDesafioDeMfa(banco);
  const portaDeMfa = criarServicoDeDesafioDeMfa({
    fatores,
    codigos,
    desafios,
    masterKey: MASTER,
    ttlMs: 300_000,
    maxTentativas: 5,
  });

  const authService = criarAuthService({
    repo: repoAuth,
    servicoDeSenha,
    tokenService,
    refreshToken: refreshTokenService,
    denylist,
    mfa: portaDeMfa,
  });
  const verificarAccessToken = criarVerificadorDeAccessToken({
    jwks,
    denylist,
    emissor: EMISSOR,
    audiencia: 'iam-clients',
  });

  registrarRotasDeAuth(app, { authService, verificarAccessToken });
  registrarRotasDeRefresh(app, { refreshTokenService });
  await registrarRotasDeMfa(app, {
    mfaService: criarMfaService({
      fatores,
      codigos,
      desafios,
      usuarios: criarRepositorioDeUsuario(pool),
      servicoDeSenha,
      masterKey: MASTER,
      emissor: 'iam.example.com',
      sessoes: { revogarTodas: (userId) => repoRefresh.revogarDoUsuario(userId) },
    }),
    authService,
    autenticar: idAutenticado,
    verificarAccessToken,
    guards: criarGuardsDeAutorizacao(),
  });
  await app.ready();

  const hash = await servicoDeSenha.gerarHash(SENHA);
  for (const email of [EMAIL, ADMIN]) {
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  }
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.name = 'superadmin'`,
    [ADMIN],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await mongo.close();
});

describe('ciclo do segundo fator', () => {
  it('percorre cadastro, desafio, verificação e desativação', async () => {
    await limparMfa(pool);
    const inicial = await logar(EMAIL);
    // Sem fator, o login continua devolvendo o par direto.
    expect(inicial).toHaveProperty('access_token');
    const token = inicial.access_token as string;

    const { segredo } = await habilitarMfa(token);

    // Com fator ativo, o mesmo login para no desafio.
    const comDesafio = await logar(EMAIL);
    expect(comDesafio).toMatchObject({ mfa_required: true });
    expect(comDesafio).not.toHaveProperty('access_token');

    const verificacao = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.41.0.1',
      payload: {
        mfa_token: comDesafio.mfa_token as string,
        code: codigoSeguinte(segredo),
      },
    });
    expect(verificacao.statusCode).toBe(200);
    const par = verificacao.json<ParDeTokens>();
    const payload = decodeJwt(par.access_token);
    expect(payload.amr).toEqual(['pwd', 'otp']);
    expect(payload.mfa).toBe(true);

    // Desativa e o login volta a ser de um passo.
    const desativacao = await app.inject({
      method: 'DELETE',
      url: '/auth/mfa/totp',
      headers: bearer(par.access_token),
      payload: { senha: SENHA },
    });
    expect(desativacao.statusCode).toBe(204);
    expect(await logar(EMAIL)).toHaveProperty('access_token');
  });

  it('a renovação preserva o amr da sessão', async () => {
    await limparMfa(pool);
    const { segredo } = await habilitarMfa((await logar(EMAIL)).access_token as string);
    const desafio = await logar(EMAIL);
    const verificacao = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.41.0.2',
      payload: { mfa_token: desafio.mfa_token as string, code: codigoSeguinte(segredo) },
    });

    const renovacao = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: '10.41.0.3',
      payload: { refresh_token: verificacao.json<ParDeTokens>().refresh_token },
    });

    expect(renovacao.statusCode).toBe(200);
    expect(decodeJwt(renovacao.json<ParDeTokens>().access_token).amr).toEqual(['pwd', 'otp']);
  });
});

describe('proteções da verificação', () => {
  it('o mesmo código não vale duas vezes', async () => {
    await limparMfa(pool);
    const { segredo } = await habilitarMfa((await logar(EMAIL)).access_token as string);
    const codigo = codigoSeguinte(segredo);

    const primeiro = await logar(EMAIL);
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.1',
      payload: { mfa_token: primeiro.mfa_token as string, code: codigo },
    });
    expect(ok.statusCode).toBe(200);

    // Desafio novo, código repetido: o passo já foi consumido.
    const segundo = await logar(EMAIL);
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.2',
      payload: { mfa_token: segundo.mfa_token as string, code: codigo },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('o mesmo desafio não vale duas vezes', async () => {
    await limparMfa(pool);
    const { segredo } = await habilitarMfa((await logar(EMAIL)).access_token as string);
    const desafio = await logar(EMAIL);
    const payload = {
      mfa_token: desafio.mfa_token as string,
      code: codigoSeguinte(segredo),
    };

    const primeira = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.3',
      payload,
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.4',
      payload,
    });

    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(400);
  });

  it('desafio inexistente e código errado respondem a mesma coisa', async () => {
    await limparMfa(pool);
    await habilitarMfa((await logar(EMAIL)).access_token as string);
    const desafio = await logar(EMAIL);

    const inexistente = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.5',
      payload: { mfa_token: 'a'.repeat(43), code: '123456' },
    });
    const errado = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.42.0.6',
      payload: { mfa_token: desafio.mfa_token as string, code: '000000' },
    });

    expect(inexistente.statusCode).toBe(400);
    expect(errado.statusCode).toBe(400);
    expect(inexistente.json()).toEqual(errado.json());
  });

  it('cinco tentativas erradas destroem o desafio', async () => {
    await limparMfa(pool);
    const { segredo } = await habilitarMfa((await logar(EMAIL)).access_token as string);
    const desafio = await logar(EMAIL);
    const mfaToken = desafio.mfa_token as string;

    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        remoteAddress: '10.43.0.1',
        payload: { mfa_token: mfaToken, code: '000000' },
      });
    }

    // Agora nem o código certo vale: o desafio já não existe.
    const comCodigoCerto = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.43.0.2',
      payload: { mfa_token: mfaToken, code: codigoSeguinte(segredo) },
    });
    expect(comCodigoCerto.statusCode).toBe(400);
  });
});

describe('códigos de recuperação', () => {
  it('valem uma vez e marcam o método no token', async () => {
    await limparMfa(pool);
    const { codigos } = await habilitarMfa((await logar(EMAIL)).access_token as string);
    const desafio = await logar(EMAIL);

    const uso = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.44.0.1',
      payload: { mfa_token: desafio.mfa_token as string, recovery_code: codigos[0] },
    });

    expect(uso.statusCode).toBe(200);
    expect(decodeJwt(uso.json<ParDeTokens>().access_token).amr).toEqual(['pwd', 'recovery']);

    // O mesmo código não vale de novo.
    const outroDesafio = await logar(EMAIL);
    const reuso = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.44.0.2',
      payload: { mfa_token: outroDesafio.mfa_token as string, recovery_code: codigos[0] },
    });
    expect(reuso.statusCode).toBe(400);
  });

  it('o estado conta quantos restam', async () => {
    await limparMfa(pool);
    const token = (await logar(EMAIL)).access_token as string;
    const { codigos } = await habilitarMfa(token);
    const desafio = await logar(EMAIL);
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      remoteAddress: '10.44.0.3',
      payload: { mfa_token: desafio.mfa_token as string, recovery_code: codigos[1] },
    });

    const estado = await app.inject({ method: 'GET', url: '/auth/mfa', headers: bearer(token) });

    expect(estado.json()).toMatchObject({
      enabled: true,
      status: 'active',
      recovery_codes_remaining: codigos.length - 1,
    });
    expect(estado.json()).not.toHaveProperty('secret');
  });
});

describe('step-up e reset administrativo', () => {
  it('desativar sem a senha correta é recusado', async () => {
    await limparMfa(pool);
    const token = (await logar(EMAIL)).access_token as string;
    await habilitarMfa(token);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/mfa/totp',
      headers: bearer(token),
      payload: { senha: 'Outr@Senha!' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('cadastrar com fator ativo responde 409', async () => {
    await limparMfa(pool);
    const token = (await logar(EMAIL)).access_token as string;
    await habilitarMfa(token);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp',
      headers: bearer(token),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });

  it('o superadmin reseta a conta travada e derruba as sessões dela', async () => {
    await limparMfa(pool);
    const vitima = await logar(EMAIL);
    await habilitarMfa(vitima.access_token as string);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      EMAIL,
    ]);
    const admin = await logar(ADMIN);

    const reset = await app.inject({
      method: 'POST',
      url: `/users/${rows[0]?.id ?? ''}/mfa/reset`,
      headers: bearer(admin.access_token as string),
    });

    expect(reset.statusCode).toBe(204);
    // Volta a logar em um passo…
    expect(await logar(EMAIL)).toHaveProperty('access_token');
    // …e o refresh anterior à intervenção não vale mais.
    const renovacao = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: '10.45.0.1',
      payload: { refresh_token: vitima.refresh_token as string },
    });
    expect(renovacao.statusCode).toBe(401);
  });

  it('sem a permissão mfa:reset o reset é negado', async () => {
    await limparMfa(pool);
    const comum = await logar(EMAIL);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      ADMIN,
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/users/${rows[0]?.id ?? ''}/mfa/reset`,
      headers: bearer(comum.access_token as string),
    });

    expect(res.statusCode).toBe(403);
  });
});
