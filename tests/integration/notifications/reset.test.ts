/**
 * Cobre a entrega do token de reset ponta a ponta, contra bancos reais.
 *
 * É o fluxo que estava incompleto na `main`: o serviço gerava o token e o único concreto
 * ligado o descartava num log. Os casos que importam: o link entrega um token que de fato
 * abre o reset, conta inexistente não gera mensagem nenhuma, e o teto por destinatário
 * impede que "esqueci minha senha" vire um botão de inundar a caixa de entrada da vítima.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao, urlPostgresDeTeste } from '../helpers/ambiente.js';
import { recriarSchema } from '../users/schema.js';
import { criarLogger } from '../../../src/shared/logger/index.js';
import { criarServicoDeSenha } from '../../../src/shared/crypto/password.service.js';
import { criarContadorNoMongo } from '../../../src/shared/rate-limit/mongo-store.js';
import { criarPasswordService } from '../../../src/modules/password/services/password.service.js';
import { criarRepositorioDeTokenDeReset } from '../../../src/modules/password/repositories/reset-token.repository.js';
import { criarRepositorioDeHistorico } from '../../../src/modules/password/repositories/password-history.repository.js';
import { criarRepositorioDeUsuario } from '../../../src/modules/users/index.js';
import {
  criarCanalDeReset,
  criarServicoDeNotificacao,
  criarResolvedorDeDestinatario,
} from '../../../src/modules/notifications/index.js';
import type { PasswordService } from '../../../src/modules/password/services/password.service.js';
import type { MensagemDeEmail } from '../../../src/modules/notifications/types/mensagem.js';

const SENHA = 'S3nh@Forte!';
const NOVA = 'Outr@S3nhaBoa!';
const VITIMA = 'vitima@iam.local';
const URL_RESET = 'https://conta.exemplo.com/redefinir';
const TETO = 3;

let pool: Pool;
let cliente: MongoClient;
let banco: Db;
let servico: PasswordService;
let enviadas: MensagemDeEmail[];

/** O token que viajou no link — é o que o usuário de verdade teria em mãos. */
function tokenDoLink(mensagem: MensagemDeEmail | undefined): string {
  const url = /https:\/\/\S+/.exec(mensagem?.texto ?? '')?.[0] ?? '';
  return new URL(url).searchParams.get('token') ?? '';
}

beforeAll(async () => {
  pool = new Pool({ connectionString: urlPostgresDeTeste() });
  ({ cliente, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  await recriarSchema(pool);

  enviadas = [];
  const logger = criarLogger({ nivel: 'fatal' });
  const notificacoes = criarServicoDeNotificacao({
    transporte: {
      enviar(mensagem) {
        enviadas.push(mensagem);
        return Promise.resolve({ ok: true as const });
      },
    },
    destinatarios: criarResolvedorDeDestinatario({ pool }),
    teto: criarContadorNoMongo({ banco, timeoutMs: 500 }),
    maxPorHora: TETO,
    logger,
  });

  servico = criarPasswordService({
    servicoDeSenha: criarServicoDeSenha({ custo: 2 ** 14, blocos: 8, paralelismo: 1 }),
    usuarios: criarRepositorioDeUsuario(pool),
    tokensDeReset: criarRepositorioDeTokenDeReset(banco),
    historico: criarRepositorioDeHistorico(pool),
    sessoes: { revogarTodas: () => Promise.resolve() },
    notificacao: criarCanalDeReset({ notificacoes, urlDeReset: URL_RESET, validadeMin: 30 }),
    ttlResetMin: 30,
    historicoN: 3,
  });
}, 60_000);

beforeEach(async () => {
  enviadas.length = 0;
  await pool.query('TRUNCATE users CASCADE');
  await banco.collection('password_reset_tokens').deleteMany({});
  await banco.collection('rate_limit_counters').deleteMany({});

  const hash = await criarServicoDeSenha({
    custo: 2 ** 14,
    blocos: 8,
    paralelismo: 1,
  }).gerarHash(SENHA);
  await pool.query("INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active')", [
    VITIMA,
    hash,
  ]);
});

afterAll(async () => {
  await cliente.close();
  await pool.end();
});

describe('solicitarReset', () => {
  it('entrega um link cujo token abre o reset', async () => {
    await servico.solicitarReset({ email: VITIMA });

    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]?.para).toEqual([VITIMA]);
    expect(enviadas[0]?.assunto).toBe('Redefinição de senha');

    // A prova de que o link serve: o token que veio nele conclui o reset.
    await expect(
      servico.confirmarReset({ token: tokenDoLink(enviadas[0]), senhaNova: NOVA }),
    ).resolves.toBeUndefined();
  });

  it('conta inexistente não gera mensagem nenhuma', async () => {
    await servico.solicitarReset({ email: 'ninguem@iam.local' });

    // A defesa contra enumeração é o 202 idêntico do controller; aqui o que importa é que
    // ninguém recebe e-mail por causa de um endereço digitado por outra pessoa.
    expect(enviadas).toHaveLength(0);
  });

  it('conta bloqueada não gera mensagem', async () => {
    await pool.query("UPDATE users SET status = 'blocked' WHERE email = $1", [VITIMA]);

    await servico.solicitarReset({ email: VITIMA });

    expect(enviadas).toHaveLength(0);
  });

  it('o teto por destinatário corta o mail-bomb distribuído', async () => {
    for (let tentativa = 0; tentativa < TETO + 5; tentativa += 1) {
      await servico.solicitarReset({ email: VITIMA, ipOrigem: `10.8.0.${String(tentativa)}` });
    }

    // O limite por IP da SPEC 016 não alcança quem troca de endereço; a vítima é a mesma.
    expect(enviadas).toHaveLength(TETO);
  });

  it('o token não aparece em nenhum outro lugar da mensagem', async () => {
    await servico.solicitarReset({ email: VITIMA });
    const token = tokenDoLink(enviadas[0]);
    const inteiro = `${enviadas[0]?.assunto ?? ''}\n${enviadas[0]?.texto ?? ''}`;

    expect(inteiro.split(token)).toHaveLength(2);
  });

  it('o que persiste continua sendo só o digest do token', async () => {
    await servico.solicitarReset({ email: VITIMA });
    const token = tokenDoLink(enviadas[0]);
    const documentos = await banco.collection('password_reset_tokens').find({}).toArray();

    expect(JSON.stringify(documentos)).not.toContain(token);
  });
});
