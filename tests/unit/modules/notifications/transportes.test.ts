/**
 * Cobre os dois transportes contra um servidor HTTP local.
 *
 * O que precisa ser verdade: falha é resultado e não exceção, o timeout corta, não há
 * segunda tentativa, e nada do que o provedor responde no erro entra no log — provedor
 * costuma ecoar a requisição, que carrega o destinatário e o token de reset.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { criarTransporteHttp } from '../../../../src/modules/notifications/services/transporte-http.js';
import {
  criarDigestDeEndereco,
  criarTransporteDeLog,
} from '../../../../src/modules/notifications/services/transporte-de-log.js';
import { transporteNulo } from '../../../../src/modules/notifications/interfaces/transporte.port.js';
import type { Logger } from '../../../../src/shared/logger/index.js';
import type { MensagemDeEmail } from '../../../../src/modules/notifications/types/mensagem.js';

const MENSAGEM: MensagemDeEmail = {
  para: ['vitima@iam.local'],
  assunto: 'Sua senha foi alterada',
  texto: 'corpo em texto',
  html: '<p>corpo em texto</p>',
};

const PEPPER = 'pepper-de-teste-com-mais-de-32-bytes-aqui';
const digestDeEndereco = criarDigestDeEndereco(PEPPER);

const ECO_DO_PROVEDOR = 'erro do provedor: to=vitima@iam.local token=token-secreto';

let servidor: Server;
let url: string;
let recebidas: { corpo: string; autorizacao: string | undefined }[] = [];
/** O que o próximo pedido recebe de volta. */
let responder: (responder: (status: number, corpo: string) => void) => void;

beforeAll(async () => {
  servidor = createServer((requisicao, resposta) => {
    let corpo = '';
    requisicao.on('data', (parte: Buffer) => {
      corpo += parte.toString('utf8');
    });
    requisicao.on('end', () => {
      recebidas.push({ corpo, autorizacao: requisicao.headers.authorization });
      responder((status, texto) => {
        resposta.writeHead(status);
        resposta.end(texto);
      });
    });
  });

  await new Promise<void>((resolver) => {
    servidor.listen(0, '127.0.0.1', resolver);
  });
  url = `http://127.0.0.1:${String((servidor.address() as AddressInfo).port)}/emails`;
});

afterAll(async () => {
  await new Promise<void>((resolver, rejeitar) => {
    servidor.close((erro) => {
      if (erro === undefined) resolver();
      else rejeitar(erro);
    });
  });
});

function transporte(
  timeoutMs = 1_000,
  aoFalhar?: (erro: unknown) => void,
): ReturnType<typeof criarTransporteHttp> {
  recebidas = [];
  return criarTransporteHttp({
    url,
    token: 'token-do-provedor',
    remetente: 'seguranca@iam.local',
    timeoutMs,
    ...(aoFalhar === undefined ? {} : { aoFalhar }),
  });
}

describe('transporte http', () => {
  it('entrega e devolve sucesso', async () => {
    responder = (enviar) => {
      enviar(202, '{"id":"abc"}');
    };

    await expect(transporte().enviar(MENSAGEM)).resolves.toEqual({ ok: true });
  });

  it('manda o contrato combinado com o provedor', async () => {
    responder = (enviar) => {
      enviar(200, '');
    };

    await transporte().enviar(MENSAGEM);
    const corpo = JSON.parse(recebidas[0]?.corpo ?? '{}') as Record<string, unknown>;

    expect(corpo).toEqual({
      from: 'seguranca@iam.local',
      to: ['vitima@iam.local'],
      subject: MENSAGEM.assunto,
      text: MENSAGEM.texto,
      html: MENSAGEM.html,
    });
    expect(recebidas[0]?.autorizacao).toBe('Bearer token-do-provedor');
  });

  it('4xx é recusa, 5xx é indisponibilidade — e nenhum lança', async () => {
    responder = (enviar) => {
      enviar(422, ECO_DO_PROVEDOR);
    };
    await expect(transporte().enviar(MENSAGEM)).resolves.toEqual({
      ok: false,
      causa: 'recusado',
    });

    responder = (enviar) => {
      enviar(503, ECO_DO_PROVEDOR);
    };
    await expect(transporte().enviar(MENSAGEM)).resolves.toEqual({
      ok: false,
      causa: 'indisponivel',
    });
  });

  it('o corpo da resposta de erro não chega a quem observa a falha', async () => {
    responder = (enviar) => {
      enviar(422, ECO_DO_PROVEDOR);
    };
    const observados: unknown[] = [];

    await transporte(1_000, (erro) => {
      observados.push(erro);
    }).enviar(MENSAGEM);

    const inteiro = observados.map((erro) => String(erro)).join('\n');
    expect(inteiro).toContain('422');
    expect(inteiro).not.toContain('vitima@iam.local');
    expect(inteiro).not.toContain('token-secreto');
  });

  it('corta no timeout e não tenta de novo', async () => {
    responder = () => {
      /* nunca responde: o timeout é quem decide */
    };

    const resultado = await transporte(80).enviar(MENSAGEM);

    expect(resultado).toEqual({ ok: false, causa: 'timeout' });
    // Uma requisição só. Reenviar exige saber o que falhou, o que exige guardar o que saiu.
    expect(recebidas).toHaveLength(1);
  });

  it('destino inalcançável é indisponibilidade', async () => {
    const inalcancavel = criarTransporteHttp({
      url: 'http://127.0.0.1:1/emails',
      token: 'token',
      remetente: 'seguranca@iam.local',
      timeoutMs: 500,
    });

    await expect(inalcancavel.enviar(MENSAGEM)).resolves.toEqual({
      ok: false,
      causa: 'indisponivel',
    });
  });
});

describe('transporte de log', () => {
  function loggerFalso(): { logger: Logger; linhas: Record<string, unknown>[] } {
    const linhas: Record<string, unknown>[] = [];
    const registrar = (dados: Record<string, unknown>): void => {
      linhas.push(dados);
    };
    return {
      linhas,
      logger: { info: registrar, warn: registrar, error: registrar } as unknown as Logger,
    };
  }

  it('não registra o endereço nem o corpo', async () => {
    const { logger, linhas } = loggerFalso();

    await criarTransporteDeLog(logger, PEPPER).enviar(MENSAGEM);
    const inteiro = JSON.stringify(linhas);

    expect(inteiro).not.toContain('vitima@iam.local');
    expect(inteiro).not.toContain('corpo em texto');
    expect(inteiro).toContain(digestDeEndereco('vitima@iam.local'));
  });

  it('devolve sucesso — em desenvolvimento, falha seria falso incidente', async () => {
    await expect(
      criarTransporteDeLog(loggerFalso().logger, PEPPER).enviar(MENSAGEM),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it('o digest normaliza caixa e espaço', () => {
    expect(digestDeEndereco(' VITIMA@iam.local ')).toBe(digestDeEndereco('vitima@iam.local'));
  });

  it('o digest depende do pepper — sem ele, uma wordlist reverteria o endereço', () => {
    const outro = criarDigestDeEndereco('outro-pepper-de-teste-com-32-bytes-ok');

    expect(outro('vitima@iam.local')).not.toBe(digestDeEndereco('vitima@iam.local'));
  });
});

describe('transporte nulo', () => {
  it('não entrega e diz por quê', async () => {
    await expect(transporteNulo().enviar(MENSAGEM)).resolves.toEqual({
      ok: false,
      causa: 'nao_configurado',
    });
  });

  it('não toca na rede', async () => {
    const espiao = vi.spyOn(globalThis, 'fetch');

    await transporteNulo().enviar(MENSAGEM);

    expect(espiao).not.toHaveBeenCalled();
    espiao.mockRestore();
  });
});
