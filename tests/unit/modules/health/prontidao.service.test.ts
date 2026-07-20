/**
 * Cobre o serviço de prontidão: paralelismo, cache assimétrico, encerramento e log de
 * transição.
 *
 * A assimetria do cache é o ponto mais fácil de errar: cachear o estado degradado
 * atrasaria a recuperação, e o serviço voltaria a funcionar continuando a ser reportado
 * como fora até a janela expirar.
 */
import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { criarServicoDeProntidao } from '../../../../src/modules/health/services/prontidao.service.js';
import type {
  EstadoDeDependencia,
  Verificador,
} from '../../../../src/modules/health/services/verificadores.js';
import { criarLogger, type Logger } from '../../../../src/shared/logger/index.js';

/** Logger que acumula o que foi emitido, para inspeção. */
function loggerColetor(): { logger: Logger; linhas: () => string[] } {
  const pedacos: string[] = [];
  const destino = new Writable({
    write(chunk: Buffer, _cod, cb): void {
      pedacos.push(chunk.toString());
      cb();
    },
  });
  return {
    logger: criarLogger({ nivel: 'warn', destino }),
    linhas: () => pedacos.join('').split('\n').filter(Boolean),
  };
}

function loggerMudo(): Logger {
  return criarLogger({
    nivel: 'fatal',
    destino: new Writable({
      write(_c, _e, cb): void {
        cb();
      },
    }),
  });
}

/** Verificador controlável: `estados` é consumido em sequência a cada chamada. */
function verificadorFalso(
  nome: 'postgres' | 'mongodb',
  estados: ('up' | 'down')[],
  atrasoMs = 0,
): { verificador: Verificador; chamadas: () => number } {
  let indice = 0;
  let chamadas = 0;

  const verificador: Verificador = async () => {
    chamadas += 1;
    const estado = estados[Math.min(indice, estados.length - 1)] ?? 'up';
    indice += 1;
    if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
    const resultado: EstadoDeDependencia =
      estado === 'up'
        ? { nome, estado: 'up', duracao_ms: atrasoMs }
        : { nome, estado: 'down', duracao_ms: atrasoMs, motivo: 'indisponivel' };
    return resultado;
  };

  return { verificador, chamadas: () => chamadas };
}

describe('checagem paralela', () => {
  it('roda os verificadores ao mesmo tempo, não em sequência', async () => {
    const a = verificadorFalso('postgres', ['up'], 80);
    const b = verificadorFalso('mongodb', ['up'], 80);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador, b.verificador],
      cacheMs: 0,
      logger: loggerMudo(),
    });

    const inicio = Date.now();
    await servico.consultar();
    const decorrido = Date.now() - inicio;

    // Em série seriam ~160ms. Em paralelo, ~80ms. Com dependências lentas, a diferença
    // é o que faz a resposta caber ou não no timeout da sonda.
    expect(decorrido).toBeLessThan(150);
  });

  it('reporta pronto apenas quando todas as dependências estão up', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const b = verificadorFalso('mongodb', ['down']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador, b.verificador],
      cacheMs: 0,
      logger: loggerMudo(),
    });

    const resultado = await servico.consultar();

    expect(resultado.pronto).toBe(false);
    expect(resultado.dependencias.find((d) => d.nome === 'mongodb')?.estado).toBe('down');
    expect(resultado.dependencias.find((d) => d.nome === 'postgres')?.estado).toBe('up');
  });
});

describe('cache assimétrico', () => {
  it('reutiliza o resultado positivo dentro da janela', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 5_000,
      logger: loggerMudo(),
    });

    await servico.consultar();
    await servico.consultar();
    await servico.consultar();

    expect(a.chamadas()).toBe(1);
  });

  it('100 consultas na mesma janela geram uma verificação por dependência', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const b = verificadorFalso('mongodb', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador, b.verificador],
      cacheMs: 5_000,
      logger: loggerMudo(),
    });

    await Promise.all(Array.from({ length: 100 }, () => servico.consultar()));

    // Sem cache, a sonda vira carga constante no banco, multiplicada por réplica.
    expect(a.chamadas()).toBeLessThanOrEqual(2);
    expect(b.chamadas()).toBeLessThanOrEqual(2);
  });

  it('NÃO cacheia resultado negativo: a próxima consulta verifica de novo', async () => {
    const a = verificadorFalso('postgres', ['down', 'up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 5_000,
      logger: loggerMudo(),
    });

    const primeira = await servico.consultar();
    const segunda = await servico.consultar();

    // Cachear a falha atrasaria a recuperação: o serviço voltaria e continuaria sendo
    // reportado como fora até a janela expirar.
    expect(primeira.pronto).toBe(false);
    expect(segunda.pronto).toBe(true);
    expect(a.chamadas()).toBe(2);
  });

  it('cacheMs zero desliga o cache', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 0,
      logger: loggerMudo(),
    });

    await servico.consultar();
    await servico.consultar();

    expect(a.chamadas()).toBe(2);
  });

  it('reverifica depois que a janela expira', async () => {
    vi.useFakeTimers();
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 1_000,
      logger: loggerMudo(),
    });

    await servico.consultar();
    vi.advanceTimersByTime(1_500);
    await servico.consultar();

    expect(a.chamadas()).toBe(2);
    vi.useRealTimers();
  });
});

describe('encerramento', () => {
  it('reporta não-pronto assim que marcado, mesmo com dependências up', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 5_000,
      logger: loggerMudo(),
    });

    await servico.consultar();
    servico.marcarEncerrando();
    const resultado = await servico.consultar();

    expect(resultado.pronto).toBe(false);
    expect(resultado.encerrando).toBe(true);
  });

  it('não serve resultado positivo cacheado depois de marcado', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 60_000,
      logger: loggerMudo(),
    });

    await servico.consultar(); // popula o cache
    servico.marcarEncerrando();

    // Servir o cache aqui mandaria tráfego para uma instância que já está drenando.
    expect((await servico.consultar()).pronto).toBe(false);
  });

  it('não consulta as dependências durante o encerramento', async () => {
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 0,
      logger: loggerMudo(),
    });

    servico.marcarEncerrando();
    await servico.consultar();

    expect(a.chamadas()).toBe(0);
  });
});

describe('log de transição', () => {
  it('emite apenas quando o estado muda', async () => {
    const coletor = loggerColetor();
    const a = verificadorFalso('postgres', ['up', 'up', 'down', 'down', 'up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 0,
      logger: coletor.logger,
    });

    for (let i = 0; i < 5; i += 1) await servico.consultar();

    // up→down e down→up. A primeira checagem não é transição.
    expect(coletor.linhas()).toHaveLength(2);
  });

  it('50 checagens com o mesmo estado não produzem log algum', async () => {
    const coletor = loggerColetor();
    const a = verificadorFalso('postgres', ['up']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 0,
      logger: coletor.logger,
    });

    for (let i = 0; i < 50; i += 1) await servico.consultar();

    // A sonda bate a cada poucos segundos: logar toda checagem enterraria a linha
    // que importa sob milhares de linhas idênticas.
    expect(coletor.linhas()).toHaveLength(0);
  });

  it('a linha de transição identifica a dependência e o sentido', async () => {
    const coletor = loggerColetor();
    const a = verificadorFalso('postgres', ['up', 'down']);
    const servico = criarServicoDeProntidao({
      verificadores: [a.verificador],
      cacheMs: 0,
      logger: coletor.logger,
    });

    await servico.consultar();
    await servico.consultar();

    const linha = coletor.linhas()[0] ?? '';
    expect(linha).toContain('postgres');
    expect(linha).toContain('health.transicao');
  });
});
