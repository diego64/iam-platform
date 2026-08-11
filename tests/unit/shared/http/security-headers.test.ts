/**
 * Cobre a política de cabeçalhos como declaração: o que ela promete, sem subir servidor.
 *
 * Estes casos existem para que trocar um valor por engano — `DENY` virando `SAMEORIGIN`,
 * `preload` sendo ligado sem decisão — reprove aqui, onde a mensagem aponta a diretiva, e
 * não num teste de integração que só diz "o cabeçalho está diferente".
 */
import { describe, expect, it } from 'vitest';
import {
  CABECALHOS_DA_DOCUMENTACAO,
  CABECALHOS_DE_ERRO_SEM_ROTA,
  CABECALHOS_DE_SEGURANCA,
} from '../../../../src/shared/http/security-headers.js';
import { SEM_ARMAZENAMENTO } from '../../../../src/shared/http/cache-control.js';

/** Extrai as diretivas da política de conteúdo, falhando se o formato mudar. */
function diretivas(opcoes: typeof CABECALHOS_DE_SEGURANCA): Record<string, readonly string[]> {
  const csp = opcoes.contentSecurityPolicy;
  if (typeof csp !== 'object' || !('directives' in csp)) {
    throw new Error('política de conteúdo ausente ou em formato inesperado');
  }
  return csp.directives as Record<string, readonly string[]>;
}

describe('política de conteúdo das rotas de API', () => {
  it('nega tudo por default', () => {
    expect(diretivas(CABECALHOS_DE_SEGURANCA)['default-src']).toEqual(["'none'"]);
  });

  it('proíbe enquadramento, base, formulário e roda em caixa de areia', () => {
    const politica = diretivas(CABECALHOS_DE_SEGURANCA);

    expect(politica['frame-ancestors']).toEqual(["'none'"]);
    expect(politica['base-uri']).toEqual(["'none'"]);
    expect(politica['form-action']).toEqual(["'none'"]);
    expect(politica['sandbox']).toEqual([]);
  });

  it('não libera script de origem nenhuma — nem da própria', () => {
    const politica = diretivas(CABECALHOS_DE_SEGURANCA);

    expect(politica['script-src']).toBeUndefined();
    expect(JSON.stringify(politica)).not.toContain("'unsafe-inline'");
  });
});

describe('transporte e enquadramento', () => {
  it('exige HSTS de pelo menos um ano, com subdomínios', () => {
    const hsts = CABECALHOS_DE_SEGURANCA.strictTransportSecurity;

    expect(hsts).toMatchObject({ includeSubDomains: true });
    expect((hsts as { maxAge: number }).maxAge).toBeGreaterThanOrEqual(31_536_000);
  });

  it('mantém a pré-carga desligada — entrar na lista é decisão de quem é dono do domínio', () => {
    expect(CABECALHOS_DE_SEGURANCA.strictTransportSecurity).toMatchObject({ preload: false });
  });

  it('nega enquadramento inclusive pela própria origem', () => {
    expect(CABECALHOS_DE_SEGURANCA.frameguard).toEqual({ action: 'deny' });
  });
});

describe('vazamento entre origens', () => {
  it('não envia referenciador para lugar nenhum', () => {
    expect(CABECALHOS_DE_SEGURANCA.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });

  it('restringe leitura e abertura à mesma origem e recusa política de domínio cruzado', () => {
    expect(CABECALHOS_DE_SEGURANCA.crossOriginResourcePolicy).toEqual({ policy: 'same-origin' });
    expect(CABECALHOS_DE_SEGURANCA.crossOriginOpenerPolicy).toEqual({ policy: 'same-origin' });
    expect(CABECALHOS_DE_SEGURANCA.permittedCrossDomainPolicies).toEqual({
      permittedPolicies: 'none',
    });
  });

  it('mantém a recusa de adivinhação de tipo', () => {
    expect(CABECALHOS_DE_SEGURANCA.noSniff).toBe(true);
  });
});

describe('cabeçalhos escritos à mão para o erro sem rota', () => {
  it('a política de conteúdo é a mesma das rotas de API, apenas serializada', () => {
    const politica = diretivas(CABECALHOS_DE_SEGURANCA);
    const escrita = CABECALHOS_DE_ERRO_SEM_ROTA['content-security-policy'] ?? '';

    for (const [nome, valores] of Object.entries(politica)) {
      expect(escrita).toContain(valores.length === 0 ? nome : `${nome} ${valores.join(' ')}`);
    }
  });

  it('cobre tudo o que os ganchos escreveriam — política e diretiva de cache', () => {
    // Se alguém acrescentar um cabeçalho só às opções do plugin, este caso reprova — sem
    // ele, o caminho de erro sem rota fica para trás em silêncio.
    expect(Object.keys(CABECALHOS_DE_ERRO_SEM_ROTA).sort()).toEqual([
      'cache-control',
      'content-security-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'pragma',
      'referrer-policy',
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
      'x-permitted-cross-domain-policies',
    ]);
  });

  it('a resposta não é guardável, com a mesma diretiva do gancho de cache', () => {
    // Nenhuma rota pública chega por este caminho, então o default sem armazenamento vale
    // aqui como vale em qualquer rota não declarada.
    expect(CABECALHOS_DE_ERRO_SEM_ROTA['cache-control']).toBe(SEM_ARMAZENAMENTO);
    expect(CABECALHOS_DE_ERRO_SEM_ROTA['pragma']).toBe('no-cache');
  });

  it('repete o mesmo prazo de transporte estrito, sem pré-carga', () => {
    const hsts = CABECALHOS_DE_SEGURANCA.strictTransportSecurity as { maxAge: number };

    expect(CABECALHOS_DE_ERRO_SEM_ROTA['strict-transport-security']).toBe(
      `max-age=${String(hsts.maxAge)}; includeSubDomains`,
    );
  });
});

describe('política da documentação', () => {
  it('relaxa apenas o necessário para a UI carregar', () => {
    const politica = diretivas(CABECALHOS_DA_DOCUMENTACAO);

    expect(politica['default-src']).toEqual(["'self'"]);
    expect(politica['script-src']).toContain("'unsafe-inline'");
  });

  it('continua proibindo enquadramento — relaxar conteúdo não é relaxar tudo', () => {
    expect(diretivas(CABECALHOS_DA_DOCUMENTACAO)['frame-ancestors']).toEqual(["'none'"]);
    expect(CABECALHOS_DA_DOCUMENTACAO.frameguard).toEqual({ action: 'deny' });
  });

  it('preserva HSTS e recusa de adivinhação de tipo', () => {
    expect(CABECALHOS_DA_DOCUMENTACAO.strictTransportSecurity).toEqual(
      CABECALHOS_DE_SEGURANCA.strictTransportSecurity,
    );
    expect(CABECALHOS_DA_DOCUMENTACAO.noSniff).toBe(true);
  });
});

describe('transporte estrito — prazo', () => {
  it('vai além do piso de um ano exigido pela lista de pré-carga', () => {
    const hsts = CABECALHOS_DE_SEGURANCA.strictTransportSecurity as { maxAge: number };
    const UM_ANO = 31_536_000;

    // O cabeçalho só protege quem já visitou: prazo curto deixa a memória do navegador
    // expirar antes da próxima visita, e a primeira requisição volta a poder sair em claro.
    expect(hsts.maxAge).toBeGreaterThan(UM_ANO);
  });
});
