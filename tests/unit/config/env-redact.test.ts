/**
 * Garante que o log fatal de configuração inválida NUNCA carrega o valor recebido
 * de uma variável — só o nome e o motivo. Um secret malformado no log da plataforma
 * é um vazamento com retenção longa.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  carregarEnv,
  ErroDeConfiguracao,
  reportarErroDeConfiguracao,
} from '../../../src/config/env.js';
import { criarLogger } from '../../../src/shared/logger/index.js';

/** Coletor de saída do Pino, para inspecionar tudo que foi emitido. */
function coletorDeSaida(): { destino: Writable; texto: () => string } {
  const pedacos: string[] = [];
  const destino = new Writable({
    write(chunk: Buffer, _codificacao, callback): void {
      pedacos.push(chunk.toString());
      callback();
    },
  });
  return { destino, texto: () => pedacos.join('') };
}

/** Executa carregarEnv esperando falha e reporta o erro no logger de teste. */
function reportar(fonte: NodeJS.ProcessEnv): string {
  const { destino, texto } = coletorDeSaida();
  const logger = criarLogger({ nivel: 'fatal', destino });

  try {
    carregarEnv(fonte);
    throw new Error('esperava ErroDeConfiguracao');
  } catch (erro) {
    expect(erro).toBeInstanceOf(ErroDeConfiguracao);
    reportarErroDeConfiguracao(erro as ErroDeConfiguracao, logger);
  }

  return texto();
}

describe('reportarErroDeConfiguracao', () => {
  it('emite nível fatal com o código ENV_INVALIDO', () => {
    const saida = reportar({});
    const registro = JSON.parse(saida.trim()) as { level: number; codigo: string; msg: string };

    expect(registro.level).toBe(60); // fatal
    expect(registro.codigo).toBe('ENV_INVALIDO');
    expect(registro.msg).toBe('Configuração inválida — processo abortado');
  });

  it('lista nome e motivo de cada variável com problema', () => {
    const saida = reportar({ PORT: 'abc' });
    const registro = JSON.parse(saida.trim()) as {
      variaveis: { nome: string; problema: string }[];
    };

    const porNome = new Map(registro.variaveis.map((v) => [v.nome, v.problema]));
    expect(porNome.get('POSTGRES_URL')).toBe('obrigatória e ausente');
    expect(porNome.get('PORT')).toBeDefined();
    for (const variavel of registro.variaveis) {
      expect(Object.keys(variavel).sort()).toEqual(['nome', 'problema']);
    }
  });

  it('NÃO inclui o valor recebido de nenhuma variável na saída', () => {
    const valoresSecretos = {
      POSTGRES_URL: 'postgres://host:5432/SENTINELA-PG',
      MONGODB_URL: 'ftp://VALOR-VAZADO-MONGO',
      PORT: 'PORTA-INVALIDA-9999',
      LOG_LEVEL: 'NIVEL-VAZADO',
    };

    // POSTGRES_URL é válida no formato mas MONGODB_URL/PORT/LOG_LEVEL não são,
    // então o erro é disparado e todos os valores passam pelo caminho de reporte.
    const saida = reportar(valoresSecretos);

    expect(saida).not.toContain('SENTINELA-PG');
    expect(saida).not.toContain('VALOR-VAZADO-MONGO');
    expect(saida).not.toContain('PORTA-INVALIDA-9999');
    expect(saida).not.toContain('NIVEL-VAZADO');
  });

  it('não vaza valor mesmo quando a variável tem formato exótico', () => {
    const saida = reportar({
      POSTGRES_URL: 'postgres://ok@host:5432/iam',
      MONGODB_URL: 'mongodb://localhost:27017',
      SHUTDOWN_TIMEOUT_MS: '{"chave":"CONTEUDO-SIGILOSO"}',
    });

    expect(saida).not.toContain('CONTEUDO-SIGILOSO');
    expect(saida).toContain('SHUTDOWN_TIMEOUT_MS');
  });
});
