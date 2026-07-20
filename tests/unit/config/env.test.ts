/**
 * Cobre o contrato de configuração da SPEC 021: defaults, coerção, validação de formato,
 * agregação de erros e imutabilidade do objeto resultante.
 */
import { describe, expect, it } from 'vitest';
import {
  carregarConfigDeTelemetria,
  carregarEnv,
  ErroDeConfiguracao,
  type Env,
} from '../../../src/config/env.js';

/** Fonte mínima válida — só as variáveis sem default. */
function fonteValida(sobrescritas: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    POSTGRES_URL: 'postgres://localhost:5432/iam',
    MONGODB_URL: 'mongodb://localhost:27017',
    ...sobrescritas,
  };
}

/** Captura o ErroDeConfiguracao para inspeção, falhando se nada for lançado. */
function capturarErro(fonte: NodeJS.ProcessEnv): ErroDeConfiguracao {
  try {
    carregarEnv(fonte);
  } catch (erro) {
    expect(erro).toBeInstanceOf(ErroDeConfiguracao);
    return erro as ErroDeConfiguracao;
  }
  throw new Error('esperava ErroDeConfiguracao, mas carregarEnv teve sucesso');
}

describe('carregarEnv — defaults', () => {
  it('aplica os defaults quando as variáveis opcionais estão ausentes', () => {
    const env = carregarEnv(fonteValida());

    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.POSTGRES_POOL_MAX).toBe(10);
    expect(env.MONGODB_DB).toBe('iam_sessions');
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('respeita o valor informado em vez do default', () => {
    const env = carregarEnv(fonteValida({ NODE_ENV: 'production', LOG_LEVEL: 'warn' }));

    expect(env.NODE_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('warn');
  });
});

describe('carregarEnv — configuração de prontidão', () => {
  it('aplica os defaults de cache e timeout', () => {
    const env = carregarEnv(fonteValida());

    expect(env.HEALTH_CACHE_MS).toBe(2_000);
    expect(env.HEALTH_TIMEOUT_MS).toBe(1_000);
  });

  it('aceita cache zerado, que desliga o cache', () => {
    const env = carregarEnv(fonteValida({ HEALTH_CACHE_MS: '0' }));

    expect(env.HEALTH_CACHE_MS).toBe(0);
  });

  it.each(['-1', '30001', 'abc'])('rejeita HEALTH_CACHE_MS=%s', (valor) => {
    const erro = capturarErro(fonteValida({ HEALTH_CACHE_MS: valor }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('HEALTH_CACHE_MS');
  });

  it.each(['99', '5001', 'abc'])('rejeita HEALTH_TIMEOUT_MS=%s', (valor) => {
    // O máximo de 5s protege contra um timeout maior que o da sonda: ali o
    // orquestrador mata a requisição e conclui "fora" sem diagnóstico algum.
    const erro = capturarErro(fonteValida({ HEALTH_TIMEOUT_MS: valor }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('HEALTH_TIMEOUT_MS');
  });

  it('coage os valores vindos como string do ambiente', () => {
    const env = carregarEnv(fonteValida({ HEALTH_CACHE_MS: '500', HEALTH_TIMEOUT_MS: '250' }));

    expect(env.HEALTH_CACHE_MS).toBe(500);
    expect(env.HEALTH_TIMEOUT_MS).toBe(250);
  });
});

describe('carregarEnv — coerção de PORT', () => {
  it('converte a string do ambiente em inteiro', () => {
    const env = carregarEnv(fonteValida({ PORT: '8080' }));

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it.each(['0', '70000', 'abc', '-1', '3000.5'])('rejeita PORT=%s', (porta) => {
    const erro = capturarErro(fonteValida({ PORT: porta }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('PORT');
  });
});

describe('carregarEnv — formato das URLs', () => {
  it.each(['http://localhost:5432/iam', 'mysql://localhost:3306/iam', 'nao-e-url'])(
    'rejeita POSTGRES_URL=%s',
    (url) => {
      const erro = capturarErro(fonteValida({ POSTGRES_URL: url }));

      expect(erro.variaveis.map((v) => v.nome)).toContain('POSTGRES_URL');
    },
  );

  it('aceita postgresql:// além de postgres://', () => {
    const env = carregarEnv(fonteValida({ POSTGRES_URL: 'postgresql://iam@localhost:5432/iam' }));

    expect(env.POSTGRES_URL).toBe('postgresql://iam@localhost:5432/iam');
  });

  it('aceita mongodb+srv://', () => {
    const env = carregarEnv(fonteValida({ MONGODB_URL: 'mongodb+srv://cluster.exemplo.net' }));

    expect(env.MONGODB_URL).toBe('mongodb+srv://cluster.exemplo.net');
  });

  it('rejeita MONGODB_URL com esquema alheio', () => {
    const erro = capturarErro(fonteValida({ MONGODB_URL: 'http://localhost:27017' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('MONGODB_URL');
  });
});

describe('carregarEnv — agregação de erros', () => {
  it('reporta TODOS os problemas de uma vez, não apenas o primeiro', () => {
    const erro = capturarErro({ PORT: 'abc', LOG_LEVEL: 'barulhento' });

    const nomes = erro.variaveis.map((v) => v.nome);
    expect(nomes).toContain('POSTGRES_URL');
    expect(nomes).toContain('MONGODB_URL');
    expect(nomes).toContain('PORT');
    expect(nomes).toContain('LOG_LEVEL');
    expect(erro.variaveis.length).toBeGreaterThanOrEqual(4);
  });

  it('descreve variável ausente como "obrigatória e ausente"', () => {
    const erro = capturarErro({ MONGODB_URL: 'mongodb://localhost:27017' });

    const problema = erro.variaveis.find((v) => v.nome === 'POSTGRES_URL');
    expect(problema?.problema).toBe('obrigatória e ausente');
  });

  it('carrega o código ENV_INVALIDO', () => {
    const erro = capturarErro({});

    expect(erro.codigo).toBe('ENV_INVALIDO');
    expect(erro.name).toBe('ErroDeConfiguracao');
  });
});

describe('carregarEnv — superset e imutabilidade', () => {
  it('ignora variáveis desconhecidas em vez de invalidar (process.env é superset)', () => {
    const env = carregarEnv(fonteValida({ PATH: '/usr/bin', HOME: '/home/iam' }));

    expect(env.PORT).toBe(3000);
    expect(env).not.toHaveProperty('PATH');
  });

  it('devolve objeto congelado — mutação lança em strict mode', () => {
    const env = carregarEnv(fonteValida());

    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as unknown as { PORT: number }).PORT = 9999;
    }).toThrow(TypeError);
  });

  it('tipa o retorno como somente-leitura', () => {
    const env: Env = carregarEnv(fonteValida());

    expect(env.MONGODB_DB).toBe('iam_sessions');
  });
});

/**
 * Contrato de telemetria da SPEC 015. O caso central é `METRICS_ENABLED=false`:
 * `z.coerce.boolean()` aplicaria `Boolean('false')` — que é `true` — e a flag de
 * desligar ligaria as métricas, sem erro nenhum para denunciar.
 */
describe('carregarEnv — contrato de telemetria (SPEC 015)', () => {
  it.each(['false', '0', 'no', 'off', 'FALSE', ' false '])('trata %j como desligado', (valor) => {
    expect(carregarEnv(fonteValida({ METRICS_ENABLED: valor })).METRICS_ENABLED).toBe(false);
  });

  it.each(['true', '1', 'yes'])('trata %j como ligado', (valor) => {
    expect(carregarEnv(fonteValida({ METRICS_ENABLED: valor })).METRICS_ENABLED).toBe(true);
  });

  it('liga as métricas por padrão e mantém /metrics fechado ao público', () => {
    const env = carregarEnv(fonteValida());

    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_PUBLIC).toBe(false);
    expect(env.OTEL_SERVICE_NAME).toBe('iam-platform');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe(0.1);
  });

  it.each(['0', '1', '0.25'])('aceita %j como proporção de amostragem', (valor) => {
    expect(
      carregarEnv(fonteValida({ OTEL_TRACES_SAMPLER_ARG: valor })).OTEL_TRACES_SAMPLER_ARG,
    ).toBe(Number(valor));
  });

  it.each(['-0.1', '1.5'])('rejeita %j como proporção de amostragem', (valor) => {
    const erro = capturarErro(fonteValida({ OTEL_TRACES_SAMPLER_ARG: valor }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('OTEL_TRACES_SAMPLER_ARG');
  });

  it('rejeita endpoint OTLP que não é URL', () => {
    const erro = capturarErro(fonteValida({ OTEL_EXPORTER_OTLP_ENDPOINT: 'nao-e-url' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});

describe('carregarConfigDeTelemetria — leitura antecipada, sem lançar', () => {
  it('não exige as variáveis obrigatórias do resto da configuração', () => {
    const config = carregarConfigDeTelemetria({});

    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.OTEL_SERVICE_NAME).toBe('iam-platform');
  });

  it('lê a configuração válida informada', () => {
    const config = carregarConfigDeTelemetria({
      METRICS_ENABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_TRACES_SAMPLER_ARG: '1',
    });

    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    expect(config.OTEL_TRACES_SAMPLER_ARG).toBe(1);
  });

  it('cai nos defaults em vez de lançar quando a configuração é inválida', () => {
    // Telemetria roda antes de existir logger ou handler de erro: lançar aqui derrubaria
    // o processo por causa de uma variável de diagnóstico.
    const config = carregarConfigDeTelemetria({ OTEL_TRACES_SAMPLER_ARG: '99' });

    expect(config.OTEL_TRACES_SAMPLER_ARG).toBe(0.1);
  });
});
