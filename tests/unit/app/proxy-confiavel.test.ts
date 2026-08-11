/**
 * Cobre quantos hops de proxy são confiados ao derivar request.ip.
 *
 * É a base do rate limit por IP da SPEC 016: se este valor estiver errado, o limite
 * é contornável trocando um header, e o teste de rate limit ainda assim passaria.
 */
import { describe, expect, it } from 'vitest';
import { ehRotaDaDocumentacao, hopsDeProxyConfiaveis } from '../../../src/app.js';
import { carregarEnv } from '../../../src/config/env.js';

function envCom(ambiente: string): ReturnType<typeof carregarEnv> {
  return carregarEnv({
    NODE_ENV: ambiente,
    POSTGRES_URL: 'postgres://iam@localhost:5432/iam',
    MONGODB_URL: 'mongodb://localhost:27017',
  });
}

describe('hopsDeProxyConfiaveis', () => {
  it('confia em exatamente 1 hop em produção — o que o proxy do Render acrescenta', () => {
    expect(hopsDeProxyConfiaveis(envCom('production'))).toBe(1);
  });

  it('NUNCA confia na cadeia inteira: `true` deixaria o cliente forjar o próprio IP', () => {
    expect(hopsDeProxyConfiaveis(envCom('production'))).not.toBe(true);
  });

  it('não confia em header algum em desenvolvimento, onde não há proxy na frente', () => {
    expect(hopsDeProxyConfiaveis(envCom('development'))).toBe(false);
  });

  it('não confia em header algum em teste', () => {
    expect(hopsDeProxyConfiaveis(envCom('test'))).toBe(false);
  });
});

describe('ehRotaDaDocumentacao — alcance da política relaxada', () => {
  it('reconhece a raiz da documentação e o que está sob ela', () => {
    expect(ehRotaDaDocumentacao('/docs')).toBe(true);
    expect(ehRotaDaDocumentacao('/docs/json')).toBe(true);
    expect(ehRotaDaDocumentacao('/docs/static/index.css')).toBe(true);
  });

  it('não alcança rota que apenas começa com as mesmas letras', () => {
    // Prefixo solto casaria estas, e elas herdariam em silêncio a política relaxada da UI:
    // a rota responde normalmente, só com menos proteção, e nada avisa.
    expect(ehRotaDaDocumentacao('/docs-interno')).toBe(false);
    expect(ehRotaDaDocumentacao('/docsearch')).toBe(false);
    expect(ehRotaDaDocumentacao('/documentos')).toBe(false);
  });

  it('não alcança as rotas de API', () => {
    for (const caminho of ['/auth/login', '/health/live', '/.well-known/jwks.json']) {
      expect(ehRotaDaDocumentacao(caminho)).toBe(false);
    }
  });
});
