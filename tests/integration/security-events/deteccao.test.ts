/**
 * Detecção ponta a ponta, do fato auditado ao evento persistido.
 *
 * Os casos que importam: a rajada distribuída vira um evento e não vinte, a mesma conta
 * atacada de muitos IPs não é confundida com muitas contas atacadas de um IP, e a trilha
 * continua registrando tudo com o decorador no lugar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { conectarMongo } from '../../../src/database/mongodb/connection.js';
import { garantirIndices } from '../../../src/database/mongodb/indexes.js';
import { envDeIntegracao } from '../helpers/ambiente.js';
import { criarContadorNoMongo } from '../../../src/shared/rate-limit/mongo-store.js';
import {
  canalNulo,
  criarDetector,
  criarExtratorDeSujeito,
  criarRegistradorComDeteccao,
  criarRepositorioDeConjuntoDistinto,
  criarRepositorioDeEventosDeSeguranca,
  type RepositorioDeEventosDeSeguranca,
} from '../../../src/modules/security-events/index.js';
import type { RegistradorDeAuditoria } from '../../../src/modules/audit/interfaces/audit-recorder.js';
import type { EventoDeAuditoria } from '../../../src/modules/audit/types/audit-event.js';

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const LIMIAR = 3;
const VITIMA = 'vitima@iam.local';

let mongo: MongoClient;
let banco: Db;
let eventos: RepositorioDeEventosDeSeguranca;
let registrador: RegistradorDeAuditoria;
let gravadosNaTrilha: EventoDeAuditoria[];

const JANELA_DE_LEITURA = {
  desde: new Date(Date.now() - 60_000),
  ate: new Date(Date.now() + 60_000),
  limite: 50,
};

/** A detecção não é aguardada; o teste espera pelo efeito, sem a produção mudar por isso. */
async function aguardarEventos(quantidade: number): Promise<void> {
  for (let tentativa = 0; tentativa < 50; tentativa += 1) {
    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    if (pagina.itens.length >= quantidade) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function loginFalho(email: string, ip: string): EventoDeAuditoria {
  return {
    type: 'iam.auth.login_failed',
    actor: { id: null, type: 'user', ip },
    outcome: 'failure',
    reason: 'invalid_credentials',
    subjectEmail: email,
  };
}

beforeAll(async () => {
  ({ cliente: mongo, banco } = await conectarMongo(envDeIntegracao()));
  await garantirIndices(banco);
  eventos = criarRepositorioDeEventosDeSeguranca(banco);

  const contador = criarContadorNoMongo({ banco, timeoutMs: 500 });
  const detector = criarDetector({
    contexto: {
      contador,
      conjuntos: criarRepositorioDeConjuntoDistinto({ banco, tamanhoMaximo: 50 }),
      extrator: criarExtratorDeSujeito(PEPPER),
      limiares: {
        bruteForceMax: LIMIAR,
        bruteForceJanelaMs: 300_000,
        stuffingContasMax: LIMIAR,
        stuffingJanelaMs: 600_000,
        varreduraDeClienteMax: LIMIAR,
        varreduraDeClienteJanelaMs: 300_000,
        mfaFalhasMax: LIMIAR,
        mfaJanelaMs: 600_000,
      },
    },
    eventos,
    silencio: contador,
    silencioMs: 900_000,
    retencaoMs: 90 * 24 * 60 * 60 * 1000,
    canal: canalNulo(),
  });

  gravadosNaTrilha = [];
  registrador = criarRegistradorComDeteccao(
    {
      registrar: (evento) => {
        gravadosNaTrilha.push(evento);
        return Promise.resolve();
      },
    },
    detector,
  );
});

afterAll(async () => {
  await mongo.close();
});

beforeEach(async () => {
  await banco.collection('security_events').deleteMany({});
  await banco.collection('security_distinct_sets').deleteMany({});
  await banco.collection('rate_limit_counters').deleteMany({});
  gravadosNaTrilha = [];
});

describe('força bruta por conta', () => {
  it('a rajada de muitos IPs contra uma conta vira um evento', async () => {
    for (let tentativa = 0; tentativa < LIMIAR; tentativa += 1) {
      await registrador.registrar(loginFalho(VITIMA, `10.0.0.${String(tentativa)}`));
    }
    await aguardarEventos(1);

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    const bruteForce = pagina.itens.filter((e) => e.regra === 'brute_force_conta');
    expect(bruteForce).toHaveLength(1);
    expect(bruteForce[0]?.severidade).toBe('alta');
    expect(bruteForce[0]?.sujeito.tipo).toBe('conta');
  });

  it('a rajada seguinte, no silêncio, não gera um segundo evento', async () => {
    // Sem o freio, um ataque em curso emite alarme a cada tentativa.
    for (let tentativa = 0; tentativa < LIMIAR * 3; tentativa += 1) {
      await registrador.registrar(loginFalho(VITIMA, `10.0.1.${String(tentativa)}`));
    }
    await aguardarEventos(1);

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    expect(pagina.itens.filter((e) => e.regra === 'brute_force_conta')).toHaveLength(1);
  });

  it('abaixo do limiar não gera nada', async () => {
    await registrador.registrar(loginFalho(VITIMA, '10.0.2.1'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    expect(pagina.itens).toHaveLength(0);
  });

  it('nenhum e-mail em claro na coleção', async () => {
    for (let tentativa = 0; tentativa < LIMIAR; tentativa += 1) {
      await registrador.registrar(loginFalho(VITIMA, `10.0.3.${String(tentativa)}`));
    }
    await aguardarEventos(1);

    const documentos = await banco.collection('security_events').find({}).toArray();
    expect(JSON.stringify(documentos)).not.toContain(VITIMA);
    expect(JSON.stringify(documentos)).not.toContain('vitima');
  });
});

describe('credential stuffing', () => {
  it('contas distintas do mesmo IP viram evento de stuffing', async () => {
    for (let conta = 0; conta < LIMIAR; conta += 1) {
      await registrador.registrar(loginFalho(`alvo-${String(conta)}@iam.local`, '10.1.0.1'));
    }
    await aguardarEventos(1);

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    const stuffing = pagina.itens.filter((e) => e.regra === 'credential_stuffing');
    expect(stuffing).toHaveLength(1);
    expect(stuffing[0]?.sujeito.tipo).toBe('ip');
  });

  it('a mesma conta de muitos IPs não é confundida com stuffing', async () => {
    // É a distinção entre insistir numa conta e varrer contas.
    for (let tentativa = 0; tentativa < LIMIAR * 2; tentativa += 1) {
      await registrador.registrar(loginFalho(VITIMA, `10.2.0.${String(tentativa)}`));
    }
    await aguardarEventos(1);

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    expect(pagina.itens.some((e) => e.regra === 'credential_stuffing')).toBe(false);
  });
});

describe('reuso de refresh', () => {
  it('a primeira ocorrência já vira evento', async () => {
    await registrador.registrar({
      type: 'iam.token.reuse_detected',
      actor: { id: 'u1', type: 'user' },
      target: { id: 'fam-1', type: 'session' },
      outcome: 'failure',
      reason: 'token_reused',
    });
    await aguardarEventos(1);

    const pagina = await eventos.listar(JANELA_DE_LEITURA);
    expect(pagina.itens[0]).toMatchObject({ regra: 'reuso_de_refresh', severidade: 'alta' });
  });
});

describe('a trilha continua intacta', () => {
  it('todo evento chega ao registrador real, inclusive os que não interessam a regra nenhuma', async () => {
    await registrador.registrar(loginFalho(VITIMA, '10.3.0.1'));
    await registrador.registrar({
      type: 'iam.user.created',
      actor: { id: 'admin', type: 'user' },
      outcome: 'success',
    });

    expect(gravadosNaTrilha).toHaveLength(2);
    expect(gravadosNaTrilha.map((e) => e.type)).toEqual([
      'iam.auth.login_failed',
      'iam.user.created',
    ]);
  });

  it('a trilha é gravada mesmo quando o detector não consegue trabalhar', async () => {
    const { cliente: efemero, banco: bancoEfemero } = await conectarMongo(envDeIntegracao());
    await efemero.close();
    const gravados: EventoDeAuditoria[] = [];
    const comDetectorQuebrado = criarRegistradorComDeteccao(
      {
        registrar: (evento) => {
          gravados.push(evento);
          return Promise.resolve();
        },
      },
      criarDetector({
        contexto: {
          contador: criarContadorNoMongo({ banco: bancoEfemero, timeoutMs: 100 }),
          conjuntos: criarRepositorioDeConjuntoDistinto({
            banco: bancoEfemero,
            tamanhoMaximo: 50,
          }),
          extrator: criarExtratorDeSujeito(PEPPER),
          limiares: {
            bruteForceMax: 1,
            bruteForceJanelaMs: 1000,
            stuffingContasMax: 1,
            stuffingJanelaMs: 1000,
            varreduraDeClienteMax: 1,
            varreduraDeClienteJanelaMs: 1000,
            mfaFalhasMax: 1,
            mfaJanelaMs: 1000,
          },
        },
        eventos: criarRepositorioDeEventosDeSeguranca(bancoEfemero),
        silencio: criarContadorNoMongo({ banco: bancoEfemero, timeoutMs: 100 }),
        silencioMs: 1000,
        retencaoMs: 1000,
      }),
    );

    await expect(
      comDetectorQuebrado.registrar(loginFalho(VITIMA, '10.4.0.1')),
    ).resolves.toBeUndefined();
    expect(gravados).toHaveLength(1);
  });
});
