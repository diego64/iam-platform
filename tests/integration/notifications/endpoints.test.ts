/**
 * Cobre a rota de teste de entrega e o aviso de login novo, contra bancos reais.
 *
 * A rota existe para que a primeira prova de que o transporte funciona não seja o dia em
 * que um alerta real deveria ter saído e não saiu. Os casos que importam: quem não tem a
 * permissão não dispara, sem endereço configurado ela recusa em vez de mentir "ok", e a
 * falha do provedor é relatada sem que a mensagem dele vaze.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { recriarSchemaJwks } from '../jwks/schema.js';
import { aplicarMetadadosRbac } from '../rbac/schema.js';
import { recriarCheckpoints } from '../audit/schema.js';
import { montarAppDeNotificacoes } from './helper-app.js';
import type { MensagemDeEmail } from '../../../src/modules/notifications/types/mensagem.js';

const DDL_NOTIFICACOES = readFileSync(
  new URL('../../../src/database/migrations/0011_notifications.sql', import.meta.url),
  'utf8',
);

const SENHA = 'S3nh@Forte!';
const OPERADOR = 'operador@iam.local';
const CURIOSO = 'curioso@iam.local';
const OPERACAO = ['seg@exemplo.com'];

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let app: FastifyInstance;
let enviadas: MensagemDeEmail[];
let tokenOperador: string;
let tokenCurioso: string;
let ip = 0;

type Resposta = Awaited<ReturnType<FastifyInstance['inject']>>;

function proximoIp(): string {
  ip += 1;
  return `10.9.0.${String(ip)}`;
}

async function logar(email: string, agente = 'vitest/1.0'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: proximoIp(),
    headers: { 'user-agent': agente },
    payload: { email, senha: SENHA },
  });
  return res.json<{ access_token: string }>().access_token;
}

async function criarUsuario(email: string, permissoes: string[]): Promise<void> {
  const { servicoDeSenha } = await montarAppDeNotificacoes({ pool, banco });
  const hash = await servicoDeSenha.gerarHash(SENHA);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const userId = rows[0]?.id ?? '';
  if (permissoes.length === 0) return;

  const papel = `papel-${email.split('@')[0] ?? 'x'}`;
  await pool.query('INSERT INTO roles (name) VALUES ($1) ON CONFLICT DO NOTHING', [papel]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE name = $2 ON CONFLICT DO NOTHING`,
    [userId, papel],
  );
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
      WHERE r.name = $1 AND p.name = ANY($2::text[]) ON CONFLICT DO NOTHING`,
    [papel, permissoes],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste() });
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await recriarSchema(pool);
  await recriarSchemaJwks(pool);
  await aplicarMetadadosRbac(pool);
  await recriarCheckpoints(pool);
  await pool.query(DDL_NOTIFICACOES);
  await banco.collection('audit_log').deleteMany({});
  await banco.collection('audit_chain_head').deleteMany({});
  await banco.collection('known_devices').deleteMany({});
  await banco.collection('rate_limit_counters').deleteMany({});

  ({ app, enviadas } = await montarAppDeNotificacoes({
    pool,
    banco,
    destinatariosDeOperacao: OPERACAO,
  }));

  await criarUsuario(OPERADOR, ['notifications:send']);
  await criarUsuario(CURIOSO, []);

  tokenOperador = await logar(OPERADOR);
  tokenCurioso = await logar(CURIOSO);
}, 60_000);

afterAll(async () => {
  await app.close();
  await cliente.close();
  await pool.end();
});

describe('POST /notifications/test', () => {
  it('dispara a mensagem para os endereços de operação', async () => {
    const antes = enviadas.length;

    const res = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${tokenOperador}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resultado: 'ok', destinatarios: 1, transporte: 'log' });
    expect(enviadas.length).toBe(antes + 1);
    expect(enviadas.at(-1)?.para).toEqual(OPERACAO);
    expect(enviadas.at(-1)?.assunto).toBe('[IAM] Teste de entrega');
  });

  it('sem a permissão, 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${tokenCurioso}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it('sem token, 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/notifications/test', payload: {} });

    expect(res.statusCode).toBe(401);
  });

  it('campo extra no corpo é recusado — o destinatário nunca vem da requisição', async () => {
    // App próprio: o limite de 3/min é por instância, e os casos acima já gastaram a cota.
    const { app: limpo } = await montarAppDeNotificacoes({
      pool,
      banco,
      destinatariosDeOperacao: OPERACAO,
    });

    const res = await limpo.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${tokenOperador}` },
      payload: { para: 'vitima@exemplo.com' },
    });

    // Um endereço aceito aqui transformaria a rota num relay de spam autenticado.
    expect(res.statusCode).toBe(400);
    await limpo.close();
  });

  it('a quarta chamada do minuto é recusada — a rota é diagnóstico, não canal', async () => {
    const { app: limpo } = await montarAppDeNotificacoes({
      pool,
      banco,
      destinatariosDeOperacao: OPERACAO,
    });
    const disparar = async (): Promise<Resposta> =>
      limpo.inject({
        method: 'POST',
        url: '/notifications/test',
        headers: { authorization: `Bearer ${tokenOperador}` },
        payload: {},
      });

    for (let tentativa = 0; tentativa < 3; tentativa += 1) await disparar();

    expect((await disparar()).statusCode).toBe(429);
    await limpo.close();
  });

  it('sem endereço de operação configurado, 409', async () => {
    const { app: semOperacao } = await montarAppDeNotificacoes({ pool, banco });

    const res = await semOperacao.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${tokenOperador}` },
      payload: {},
    });

    // Responder "ok" esconderia justamente a configuração faltando que a rota revela.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('notifications-not-configured');
    await semOperacao.close();
  });

  it('provedor fora do ar responde 200 relatando erro, sem vazar a mensagem dele', async () => {
    const { app: comProvedorFora } = await montarAppDeNotificacoes({
      pool,
      banco,
      destinatariosDeOperacao: OPERACAO,
      transporteQuebrado: true,
    });

    const res = await comProvedorFora.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${tokenOperador}` },
      payload: {},
    });

    // 200 porque o pedido estava certo; o que falhou foi o provedor.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resultado: 'erro', causa: 'indisponivel' });
    await comProvedorFora.close();
  });
});

describe('aviso de login novo', () => {
  it('o primeiro login de um dispositivo avisa o dono da conta', async () => {
    const antes = enviadas.length;

    await logar(OPERADOR, 'Mozilla/5.0 (dispositivo-novo)');
    await new Promise((resolver) => setTimeout(resolver, 300));

    const novas = enviadas.slice(antes);
    const aviso = novas.find((m) => m.assunto === 'Novo acesso à sua conta');

    expect(aviso?.para).toEqual([OPERADOR]);
    expect(aviso?.texto).toContain('troque sua senha imediatamente');
  });

  it('o segundo login do mesmo dispositivo não avisa', async () => {
    await logar(OPERADOR, 'Mozilla/5.0 (dispositivo-repetido)');
    await new Promise((resolver) => setTimeout(resolver, 300));
    const antes = enviadas.length;

    await logar(OPERADOR, 'Mozilla/5.0 (dispositivo-repetido)');
    await new Promise((resolver) => setTimeout(resolver, 300));

    expect(enviadas.length).toBe(antes);
  });

  it('login falho não avisa ninguém', async () => {
    const antes = enviadas.length;

    await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      headers: { 'user-agent': 'Mozilla/5.0 (atacante)' },
      payload: { email: OPERADOR, senha: 'ErradaMesmo!1' },
    });
    await new Promise((resolver) => setTimeout(resolver, 300));

    // Avisar por tentativa daria a quem ataca um botão de incomodar a vítima à vontade.
    expect(enviadas.length).toBe(antes);
  });

  it('login de conta inexistente não avisa ninguém', async () => {
    const antes = enviadas.length;

    await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: proximoIp(),
      payload: { email: 'ninguem@iam.local', senha: 'ErradaMesmo!1' },
    });
    await new Promise((resolver) => setTimeout(resolver, 300));

    expect(enviadas.length).toBe(antes);
  });

  it('a trilha continua registrando com os dois decoradores na pilha', async () => {
    const antes = await banco.collection('audit_log').countDocuments();

    await logar(OPERADOR, 'Mozilla/5.0 (mais-um)');
    await new Promise((resolver) => setTimeout(resolver, 300));

    // O risco da pilha é justamente este: errar a ordem e a trilha parar de registrar.
    expect(await banco.collection('audit_log').countDocuments()).toBeGreaterThan(antes);
  });

  it('nenhum e-mail em claro chegou à coleção de dispositivos', async () => {
    const documentos = await banco.collection('known_devices').find({}).toArray();

    expect(JSON.stringify(documentos)).not.toContain('@');
  });
});
