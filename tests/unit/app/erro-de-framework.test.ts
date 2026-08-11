/**
 * Cobre a tradução dos erros que o Fastify emite antes de haver rota.
 *
 * Este caminho não passa por gancho nenhum — nem `onRequest`, onde o plugin escreve os
 * cabeçalhos, nem `onSend`, onde o controle de cache decide —, então tudo o que a resposta
 * carrega é escrito aqui. Duas coisas precisam continuar valendo: a política de segurança
 * sai junto, e nem a resposta nem o log carregam a string que o cliente enviou.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { responderErroDeFramework } from '../../../src/app.js';
import { CABECALHOS_DE_ERRO_SEM_ROTA } from '../../../src/shared/http/security-headers.js';

const CAMINHO_OFENSIVO = `/users/${'x'.repeat(300)}`;

/** Erro no formato que o roteador do Fastify produz: a mensagem embute o que foi recebido. */
function erroDeCaminhoLongo(status = 414): FastifyError {
  return Object.assign(new Error(`'${CAMINHO_OFENSIVO}' is exceeding the max param length`), {
    code: 'FST_ERR_MAX_PARAM_LENGTH',
    statusCode: status,
    name: 'FastifyError',
  });
}

/** Resposta encadeável que apenas registra o que recebeu. */
function respostaFalsa(): {
  resposta: FastifyReply;
  registro: { status?: number; cabecalhos: Record<string, string>; tipo?: string; corpo?: unknown };
} {
  const registro: {
    status?: number;
    cabecalhos: Record<string, string>;
    tipo?: string;
    corpo?: unknown;
  } = { cabecalhos: {} };

  const resposta = {
    status(codigo: number) {
      registro.status = codigo;
      return this;
    },
    headers(valores: Record<string, string>) {
      Object.assign(registro.cabecalhos, valores);
      return this;
    },
    type(valor: string) {
      registro.tipo = valor;
      return this;
    },
    send(corpo: unknown) {
      registro.corpo = corpo;
      return this;
    },
  } as unknown as FastifyReply;

  return { resposta, registro };
}

function requisicaoFalsa(): {
  requisicao: FastifyRequest;
  avisos: unknown[][];
  erros: unknown[][];
} {
  const avisos: unknown[][] = [];
  const erros: unknown[][] = [];

  const requisicao = {
    method: 'GET',
    log: {
      warn: vi.fn((...args: unknown[]) => avisos.push(args)),
      error: vi.fn((...args: unknown[]) => erros.push(args)),
    },
  } as unknown as FastifyRequest;

  return { requisicao, avisos, erros };
}

describe('resposta', () => {
  it('sai em problem+json com o status do erro', () => {
    const { resposta, registro } = respostaFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(), requisicaoFalsa().requisicao, resposta);

    expect(registro.status).toBe(414);
    expect(registro.tipo).toBe('application/problem+json');
    expect(registro.corpo).toMatchObject({ status: 414 });
  });

  it('não ecoa o caminho recebido', () => {
    const { resposta, registro } = respostaFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(), requisicaoFalsa().requisicao, resposta);

    expect(JSON.stringify(registro.corpo)).not.toContain('xxxx');
  });

  it('carrega a política de segurança completa', () => {
    const { resposta, registro } = respostaFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(), requisicaoFalsa().requisicao, resposta);

    expect(registro.cabecalhos).toEqual(CABECALHOS_DE_ERRO_SEM_ROTA);
  });

  it('acima de 500 usa o mesmo tipo do handler global, não erro de requisição', () => {
    const { resposta, registro } = respostaFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(503), requisicaoFalsa().requisicao, resposta);

    // Um erro de servidor rotulado como erro de requisição manda o cliente procurar defeito
    // no que ele enviou.
    expect(JSON.stringify(registro.corpo)).toContain('internal-error');
    expect(JSON.stringify(registro.corpo)).not.toContain('request-error');
  });
});

describe('registro', () => {
  it('a recusa deixa rastro — sem ele, varredura de URL não produz sinal nenhum', () => {
    const { requisicao, avisos } = requisicaoFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(), requisicao, respostaFalsa().resposta);

    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.[0]).toMatchObject({
      evento: 'erro_de_framework',
      codigo: 'FST_ERR_MAX_PARAM_LENGTH',
      status: 414,
      metodo: 'GET',
    });
  });

  it('recusa de cliente é aviso; falha de servidor é erro', () => {
    const cliente = requisicaoFalsa();
    responderErroDeFramework(erroDeCaminhoLongo(), cliente.requisicao, respostaFalsa().resposta);

    const servidor = requisicaoFalsa();
    responderErroDeFramework(
      erroDeCaminhoLongo(503),
      servidor.requisicao,
      respostaFalsa().resposta,
    );

    expect(cliente.avisos).toHaveLength(1);
    expect(cliente.erros).toHaveLength(0);
    expect(servidor.erros).toHaveLength(1);
    expect(servidor.avisos).toHaveLength(0);
  });

  it('o log carrega exatamente os quatro campos previstos, e nada mais', () => {
    const { requisicao, avisos } = requisicaoFalsa();

    responderErroDeFramework(erroDeCaminhoLongo(), requisicao, respostaFalsa().resposta);

    /*
     * Lista fechada, não busca por substring.
     *
     * A mensagem e o stack destes erros embutem o caminho ofensivo, e registrar o objeto de
     * erro devolveria ao log o que a resposta deixou de ecoar — retido por muito mais tempo
     * que a requisição. Mas procurar o caminho no JSON não detecta isso: `JSON.stringify`
     * serializa `Error` como `{}`, e quem expande a mensagem e o stack é o serializador do
     * Pino, na hora de escrever. A busca passaria com o vazamento no lugar.
     *
     * Conferir o conjunto de chaves pega qualquer campo acrescentado, inclusive um `err`.
     */
    expect(Object.keys(avisos[0]?.[0] as object).sort()).toEqual([
      'codigo',
      'evento',
      'metodo',
      'status',
    ]);
  });
});
