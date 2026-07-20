/**
 * Guarda a ordem de import do `server.ts`.
 *
 * A instrumentação automática do OpenTelemetry funciona substituindo métodos de
 * `fastify`, `pg` e `mongodb`. Se qualquer um deles já foi carregado quando o
 * `sdk.start()` roda, a substituição não acontece — sem erro, sem aviso, sem span.
 * Tudo continua funcionando e a telemetria fica silenciosamente vazia.
 *
 * Nenhum teste de comportamento percebe isso: as respostas seguem corretas, os testes
 * seguem verdes, e a ausência só aparece no dia em que alguém abre o Grafana durante um
 * incidente. Este teste é a única defesa contra um reordenamento de imports desligar a
 * observabilidade inteira.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const servidor = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');

/** Especificadores de módulo na ordem em que aparecem no arquivo. */
function importsEmOrdem(fonte: string): string[] {
  return [...fonte.matchAll(/^import\s[^;]*?['"]([^'"]+)['"];/gms)].map(
    (achado) => achado[1] ?? '',
  );
}

describe('ordem de import do server.ts', () => {
  it('a telemetria é o primeiro import do arquivo', () => {
    expect(importsEmOrdem(servidor)[0]).toBe('./telemetry/index.js');
  });

  it('nenhum módulo instrumentado é carregado antes da telemetria', () => {
    const ordem = importsEmOrdem(servidor);
    const posicaoDaTelemetria = ordem.indexOf('./telemetry/index.js');
    const antesDaTelemetria = ordem.slice(0, posicaoDaTelemetria);

    expect(antesDaTelemetria).toEqual([]);
  });

  it('o próprio módulo de telemetria não importa nada instrumentado', () => {
    // Um import de fastify/pg/mongodb aqui dentro anularia a ordem do server.ts: o
    // módulo carregaria a dependência instrumentada antes de o SDK conseguir envolvê-la.
    const instrumentados = ['fastify', 'pg', 'mongodb'];
    const arquivos = ['sdk.ts', 'index.ts', 'rotas-isentas.ts'];

    for (const arquivo of arquivos) {
      const fonte = readFileSync(
        new URL(`../../src/telemetry/${arquivo}`, import.meta.url),
        'utf8',
      );
      const importados = importsEmOrdem(fonte);

      expect(importados.filter((modulo) => instrumentados.includes(modulo))).toEqual([]);
    }
  });
});
