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

describe('carregarEnv — refresh token', () => {
  it('aplica os defaults de validade deslizante, teto absoluto e graça', () => {
    const env = carregarEnv(fonteValida());

    expect(env.REFRESH_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(env.REFRESH_TOKEN_ABSOLUTE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(env.REFRESH_REUSE_GRACE_MS).toBe(10_000);
  });

  it('aceita graça zerada, que torna a detecção de reuso imediata', () => {
    const env = carregarEnv(fonteValida({ REFRESH_REUSE_GRACE_MS: '0' }));

    expect(env.REFRESH_REUSE_GRACE_MS).toBe(0);
  });

  it.each(['59999', 'abc'])('rejeita REFRESH_TOKEN_TTL_MS=%s', (valor) => {
    const erro = capturarErro(fonteValida({ REFRESH_TOKEN_TTL_MS: valor }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('REFRESH_TOKEN_TTL_MS');
  });

  it.each(['-1', 'abc'])('rejeita REFRESH_REUSE_GRACE_MS=%s', (valor) => {
    const erro = capturarErro(fonteValida({ REFRESH_REUSE_GRACE_MS: valor }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('REFRESH_REUSE_GRACE_MS');
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

describe('carregarEnv — parâmetros de scrypt', () => {
  it('aplica os defaults do baseline (N=2^15, r=8, p=1)', () => {
    const env = carregarEnv(fonteValida());

    expect(env.SCRYPT_COST).toBe(2 ** 15);
    expect(env.SCRYPT_BLOCK_SIZE).toBe(8);
    expect(env.SCRYPT_PARALLELIZATION).toBe(1);
  });

  it('aceita custo que é potência de 2', () => {
    expect(carregarEnv(fonteValida({ SCRYPT_COST: '16384' })).SCRYPT_COST).toBe(2 ** 14);
  });

  it('rejeita custo que não é potência de 2', () => {
    const erro = capturarErro(fonteValida({ SCRYPT_COST: '30000' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('SCRYPT_COST');
  });
});

/**
 * Contrato de telemetria. O caso central é `METRICS_ENABLED=false`:
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

describe('carregarEnv — clientes de API', () => {
  it('aplica os defaults de sobreposição e throttle', () => {
    const env = carregarEnv(fonteValida());

    expect(env.CLIENT_SECRET_OVERLAP_DEFAULT_MS).toBe(86_400_000);
    expect(env.CLIENT_LAST_USED_THROTTLE_MS).toBe(300_000);
  });

  it('aceita sobreposição zero — rotação sem janela nenhuma', () => {
    const env = carregarEnv(fonteValida({ CLIENT_SECRET_OVERLAP_DEFAULT_MS: '0' }));

    expect(env.CLIENT_SECRET_OVERLAP_DEFAULT_MS).toBe(0);
  });

  // Uma segunda via de autenticação viva por mais de uma semana deixa de ser janela de
  // deploy e vira credencial paralela esquecida.
  it('rejeita sobreposição acima de sete dias', () => {
    const erro = capturarErro(
      fonteValida({ CLIENT_SECRET_OVERLAP_DEFAULT_MS: String(8 * 24 * 60 * 60 * 1000) }),
    );

    expect(erro.variaveis.map((v) => v.nome)).toContain('CLIENT_SECRET_OVERLAP_DEFAULT_MS');
  });

  it('rejeita throttle negativo', () => {
    const erro = capturarErro(fonteValida({ CLIENT_LAST_USED_THROTTLE_MS: '-1' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('CLIENT_LAST_USED_THROTTLE_MS');
  });
});

describe('carregarEnv — rotação de chaves', () => {
  it('aplica os defaults da rotação', () => {
    const env = carregarEnv(fonteValida());

    expect(env.JWKS_PREPUBLISH_MIN_MS).toBe(600_000);
    expect(env.JWKS_ROTATION_MAX_AGE_MS).toBe(2_592_000_000);
    expect(env.JWKS_ROTATION_CHECK_INTERVAL_MS).toBe(3_600_000);
    expect(env.JWKS_PURGE_AFTER_MS).toBe(86_400_000);
    expect(env.JWKS_ROTATION_ENABLED).toBe(true);
  });

  it('coage os valores informados e aceita desligar o agendador', () => {
    const env = carregarEnv(
      fonteValida({
        JWKS_PREPUBLISH_MIN_MS: '1000',
        JWKS_ROTATION_MAX_AGE_MS: '90000',
        JWKS_ROTATION_ENABLED: 'false',
      }),
    );

    expect(env.JWKS_PREPUBLISH_MIN_MS).toBe(1000);
    expect(env.JWKS_ROTATION_MAX_AGE_MS).toBe(90_000);
    expect(env.JWKS_ROTATION_ENABLED).toBe(false);
  });

  it('rejeita intervalo de verificação abaixo do mínimo', () => {
    const erro = capturarErro(fonteValida({ JWKS_ROTATION_CHECK_INTERVAL_MS: '10' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('JWKS_ROTATION_CHECK_INTERVAL_MS');
  });
});

describe('carregarEnv — coerência entre cache e janela de graça', () => {
  // A réplica com cache velho assina com a chave recém-aposentada; o token só é
  // verificável enquanto ela estiver na graça. Cache >= graça emite token natimorto.
  it('aceita cache menor que a janela de graça', () => {
    const env = carregarEnv(
      fonteValida({ JWKS_CACHE_TTL_MS: '299999', JWKS_GRACE_PERIOD_MS: '300000' }),
    );

    expect(env.JWKS_CACHE_TTL_MS).toBeLessThan(env.JWKS_GRACE_PERIOD_MS);
  });

  it('rejeita cache igual à janela de graça', () => {
    const erro = capturarErro(
      fonteValida({ JWKS_CACHE_TTL_MS: '300000', JWKS_GRACE_PERIOD_MS: '300000' }),
    );

    expect(erro.variaveis).toEqual([
      {
        nome: 'JWKS_CACHE_TTL_MS',
        problema: 'precisa ser menor que JWKS_GRACE_PERIOD_MS (rotação sem downtime)',
      },
    ]);
  });

  it('rejeita cache maior que a janela de graça', () => {
    const erro = capturarErro(
      fonteValida({ JWKS_CACHE_TTL_MS: '600000', JWKS_GRACE_PERIOD_MS: '300000' }),
    );

    expect(erro.variaveis.map((v) => v.nome)).toEqual(['JWKS_CACHE_TTL_MS']);
  });

  it('os defaults do schema são coerentes entre si', () => {
    // Guarda contra alguém baixar a graça ou subir o cache no schema sem notar o par.
    expect(() => carregarEnv(fonteValida())).not.toThrow();
  });
});

describe('carregarEnv — origens de CORS', () => {
  it('sem a variável, nenhuma origem é liberada', () => {
    const env = carregarEnv(fonteValida());

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('valor vazio também não libera nada', () => {
    const env = carregarEnv(fonteValida({ CORS_ALLOWED_ORIGINS: '' }));

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('divide a lista por vírgula e descarta o espaço em volta', () => {
    const env = carregarEnv(
      fonteValida({
        CORS_ALLOWED_ORIGINS: 'https://app.exemplo.com, http://localhost:5173',
      }),
    );

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://app.exemplo.com', 'http://localhost:5173']);
  });

  it('ignora entradas vazias deixadas por vírgula sobrando', () => {
    const env = carregarEnv(fonteValida({ CORS_ALLOWED_ORIGINS: 'https://a.exemplo.com,,' }));

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.exemplo.com']);
  });

  // Entrada com caminho nunca casa com a origem que o navegador manda: o CORS ficaria
  // fechado enquanto a configuração afirma o contrário.
  it('rejeita entrada com caminho', () => {
    const erro = capturarErro(fonteValida({ CORS_ALLOWED_ORIGINS: 'https://app.exemplo.com/app' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('rejeita entrada com barra final', () => {
    const erro = capturarErro(fonteValida({ CORS_ALLOWED_ORIGINS: 'https://app.exemplo.com/' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('rejeita valor que não é URL', () => {
    const erro = capturarErro(fonteValida({ CORS_ALLOWED_ORIGINS: 'app.exemplo.com' }));

    expect(erro.variaveis.map((v) => v.nome)).toContain('CORS_ALLOWED_ORIGINS');
  });
});
