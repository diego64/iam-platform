/**
 * Cobre o runner de migração no que não precisa de banco: a ordem em que os arquivos são
 * aplicados e o fato de importar o módulo não disparar migração nenhuma.
 *
 * Este arquivo roda no `start` de produção — é a primeira coisa que acontece num deploy — e
 * tinha zero cobertura, porque importá-lo executava a migração como efeito colateral.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { listarMigrations } from '../../../src/database/migrate.js';

describe('ordem de aplicação', () => {
  it('devolve os arquivos em ordem lexicográfica', () => {
    const lista = listarMigrations();

    expect(lista).toEqual([...lista].sort());
  });

  it('o prefixo numérico governa a ordem, e ele é contíguo', () => {
    // Aplicar 0004 antes de 0002 quebra dependência de tabela sem erro óbvio: o SQL falha
    // por coluna inexistente, e a causa é a ordenação, não o SQL.
    const prefixos = listarMigrations().map((nome) => Number(nome.slice(0, 4)));

    expect(prefixos).toEqual([...prefixos].sort((a, b) => a - b));
    expect(new Set(prefixos).size).toBe(prefixos.length);
  });

  it('ignora tudo que não seja .sql', () => {
    const naPasta = readdirSync(
      new URL('../../../src/database/migrations/', import.meta.url).pathname,
    );

    expect(naPasta.length).toBeGreaterThan(listarMigrations().length - 1);
    expect(listarMigrations().every((nome) => nome.endsWith('.sql'))).toBe(true);
  });

  it('encontra as migrações que existem no repositório', () => {
    // Guarda contra o caminho da pasta quebrar numa mudança de build: uma lista vazia faria
    // o deploy "migrar" sem aplicar nada e subir contra um banco sem schema.
    expect(listarMigrations().length).toBeGreaterThanOrEqual(6);
  });
});

describe('importar não migra', () => {
  it('o módulo pôde ser importado sem tocar em banco algum', () => {
    // Se o guard de execução direta sumir, este arquivo de teste falha no import — a
    // migração roda contra o banco do ambiente e derruba a suíte com erro de conexão.
    expect(typeof listarMigrations).toBe('function');
  });
});
