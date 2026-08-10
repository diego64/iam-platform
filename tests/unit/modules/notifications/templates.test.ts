/**
 * Cobre o conteúdo das mensagens.
 *
 * Três propriedades sustentam o resto: o assunto é literal (nada de requisição entra em
 * cabeçalho), o que vem de fora sai inerte (o user-agent é texto de quem chama), e o token
 * de reset aparece uma vez só, dentro do link.
 */
import { describe, expect, it } from 'vitest';
import type { DadosDeAlerta } from '../../../../src/modules/notifications/services/templates.js';
import {
  alertaDeSeguranca,
  ASSUNTOS_ESPERADOS,
  contaBloqueada,
  loginNovo,
  mfaAlterado,
  resetDeSenha,
  senhaAlterada,
  teste,
} from '../../../../src/modules/notifications/services/templates.js';

const QUANDO = new Date('2026-08-09T14:03:51.902Z');
const URL_RESET = 'https://conta.exemplo.com/redefinir';

describe('assuntos', () => {
  it('cada tipo usa o literal do catálogo', () => {
    expect(loginNovo({ ip: null, userAgent: null, quando: QUANDO }).assunto).toBe(
      ASSUNTOS_ESPERADOS.login_novo,
    );
    expect(senhaAlterada(QUANDO).assunto).toBe(ASSUNTOS_ESPERADOS.senha_alterada);
    expect(mfaAlterado(QUANDO).assunto).toBe(ASSUNTOS_ESPERADOS.mfa_alterado);
    expect(contaBloqueada(QUANDO).assunto).toBe(ASSUNTOS_ESPERADOS.conta_bloqueada);
    expect(resetDeSenha(URL_RESET, 'tok', 30).assunto).toBe(ASSUNTOS_ESPERADOS.reset_de_senha);
    expect(teste(QUANDO).assunto).toBe(ASSUNTOS_ESPERADOS.teste);
  });

  it('nenhum assunto de aviso ao dono carrega dado da requisição', () => {
    const corpo = loginNovo({
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      quando: QUANDO,
    });

    expect(corpo.assunto).not.toContain('203.0.113.10');
    expect(corpo.assunto).not.toContain('Mozilla');
  });
});

describe('login_novo', () => {
  it('traz quando, origem e dispositivo', () => {
    const corpo = loginNovo({ ip: '203.0.113.10', userAgent: 'Mozilla/5.0', quando: QUANDO });

    expect(corpo.texto).toContain('2026-08-09 14:03:51 (UTC)');
    expect(corpo.texto).toContain('203.0.113.10');
    expect(corpo.texto).toContain('Mozilla/5.0');
  });

  it('diz o que fazer — aviso sem instrução não serve para nada', () => {
    const corpo = loginNovo({ ip: null, userAgent: null, quando: QUANDO });

    expect(corpo.texto).toContain('troque sua senha imediatamente');
  });

  it('ausência de origem é dita, não deixada em branco', () => {
    const corpo = loginNovo({ ip: null, userAgent: null, quando: QUANDO });

    expect(corpo.texto).toContain('não identificada');
    expect(corpo.texto).toContain('não identificado');
  });

  it('escapa marcação vinda do user-agent', () => {
    const corpo = loginNovo({
      ip: null,
      userAgent: '<script>alert(1)</script>',
      quando: QUANDO,
    });

    expect(corpo.html).not.toContain('<script>');
    expect(corpo.html).toContain('&lt;script&gt;');
  });

  it('quebra de linha no user-agent não vira linha nova em lugar nenhum', () => {
    const corpo = loginNovo({
      ip: null,
      userAgent: 'curl/8\r\nBcc: vitima@exemplo.com',
      quando: QUANDO,
    });

    // A linha do dispositivo continua sendo uma linha só: é o que separa "campo no corpo"
    // de "cabeçalho novo" se este texto um dia atravessar para um transporte SMTP.
    const linhaDoDispositivo = corpo.texto
      .split('\n')
      .find((linha) => linha.startsWith('Dispositivo:'));

    expect(linhaDoDispositivo).toContain('Bcc: vitima@exemplo.com');
    expect(corpo.texto.split('\n').filter((l) => l.includes('Bcc:'))).toHaveLength(1);
  });

  it('trunca user-agent longo', () => {
    const corpo = loginNovo({ ip: null, userAgent: 'a'.repeat(500), quando: QUANDO });

    expect(corpo.texto).toContain('a'.repeat(200));
    expect(corpo.texto).not.toContain('a'.repeat(201));
  });
});

describe('reset_de_senha', () => {
  it('o token aparece uma vez só, dentro do link', () => {
    const corpo = resetDeSenha(URL_RESET, 'token-secreto-de-reset', 30);
    const ocorrencias = corpo.texto.split('token-secreto-de-reset').length - 1;

    expect(ocorrencias).toBe(1);
    expect(corpo.texto).toContain(`${URL_RESET}?token=token-secreto-de-reset`);
  });

  it('codifica o token na query em vez de concatenar às cegas', () => {
    const corpo = resetDeSenha(URL_RESET, 'a+b/c=d', 30);

    expect(corpo.texto).toContain('token=a%2Bb%2Fc%3Dd');
  });

  it('informa a validade', () => {
    expect(resetDeSenha(URL_RESET, 'tok', 30).texto).toContain('30 minutos');
  });
});

describe('alerta_de_seguranca', () => {
  const DADOS: DadosDeAlerta = {
    regra: 'brute_force_conta',
    severidade: 'alta',
    ocorrencias: 12,
    janelaMs: 300_000,
    detectadoEm: QUANDO,
    eventoId: '66b3f1c2a4e5d6f7a8b9c0d1',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  };

  it('traz o suficiente para agir', () => {
    const corpo = alertaDeSeguranca(DADOS);

    expect(corpo.assunto).toBe('[IAM] Alerta de segurança: brute_force_conta');
    expect(corpo.texto).toContain('12 em 5 min');
    expect(corpo.texto).toContain(DADOS.eventoId);
    expect(corpo.texto).toContain(DADOS.traceId);
  });

  it('trace ausente é dito, não deixado como "null"', () => {
    expect(alertaDeSeguranca({ ...DADOS, traceId: null }).texto).toContain('ausente');
  });
});

describe('todos os corpos', () => {
  const corpos = [
    loginNovo({ ip: '203.0.113.10', userAgent: 'curl/8.5.0', quando: QUANDO }),
    senhaAlterada(QUANDO),
    mfaAlterado(QUANDO),
    contaBloqueada(QUANDO),
    teste(QUANDO),
  ];

  it('nenhum carrega credencial', () => {
    for (const corpo of corpos) {
      const inteiro = `${corpo.assunto}\n${corpo.texto}\n${corpo.html}`.toLowerCase();

      for (const proibido of ['senha:', 'password', 'hash', 'secret', 'bearer', 'token']) {
        expect(inteiro).not.toContain(proibido);
      }
    }
  });

  it('os dois ramos dizem a mesma coisa', () => {
    for (const corpo of corpos) {
      for (const linha of corpo.texto.split('\n').filter((l) => l.length > 0)) {
        // O HTML sai das mesmas linhas: é o que impede a versão HTML de ganhar um dado
        // que a versão texto não tem.
        expect(corpo.html).toContain(linha.replace(/&/g, '&amp;'));
      }
    }
  });
});
