/**
 * Contrato dos cabeçalhos de segurança sobre **toda** rota que o processo serve.
 *
 * O teste não tem lista própria de rotas: ele lê o inventário que o app monta no boot. É a
 * diferença entre uma guarda que envelhece e uma que não — uma lista escrita à mão fica
 * desatualizada no primeiro módulo novo, e o buraco aparece só quando alguém for procurar.
 *
 * A política vale para todo status. Um 401 sem recusa de adivinhação de tipo expõe tanto
 * quanto um 200 sem, e é justamente nas respostas de erro que um cabeçalho some sem
 * ninguém reparar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { montarAppCompleto } from '../mocks/app-completo.js';
import { ehRotaDaDocumentacao } from '../../src/app.js';
import { CACHEAVEIS } from '../../src/shared/http/cache-control.js';

/** O que precisa sair em toda resposta, qualquer que seja o status. */
const OBRIGATORIOS: ReadonlyMap<string, string> = new Map([
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['x-permitted-cross-domain-policies', 'none'],
]);

/**
 * Rotas fora da política de API.
 *
 * A documentação interativa é HTML com script embutido e tem política própria — e nem sobe
 * em produção. O `OPTIONS *` é o preflight que o plugin de CORS instala: mecânica do
 * navegador, sem handler nosso por trás.
 */
function souRotaDeApi(caminho: string): boolean {
  return !ehRotaDaDocumentacao(caminho) && caminho !== '*';
}

/**
 * Verbo no tipo que a injeção aceita.
 *
 * O `HTTPMethods` do Fastify é mais largo que o da injeção — usá-lo aqui derruba a resolução
 * de sobrecarga, e a resposta volta tipada como encadeamento em vez de resposta.
 */
type MetodoDeInjecao = NonNullable<InjectOptions['method']>;

/** Um caminho concreto a partir do template registrado: `/users/:id` → `/users/id`. */
function caminhoConcreto(template: string): string {
  return template.replace(/:(\w+)/g, 'valor-de-teste');
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await montarAppCompleto();
});

afterAll(async () => {
  await app.close();
});

describe('cobertura do inventário', () => {
  it('o app serve rotas suficientes para o contrato significar alguma coisa', () => {
    // Guarda contra o modo de falha silencioso: se a montagem quebrar e o inventário vier
    // quase vazio, os casos abaixo passariam sem ter verificado nada.
    expect(app.inventarioDeRotas.filter((r) => souRotaDeApi(r.caminho)).length).toBeGreaterThan(30);
  });
});

describe('cabeçalhos em toda rota servida', () => {
  it('nenhuma rota escapa da política', async () => {
    const semPolitica: string[] = [];

    for (const rota of app.inventarioDeRotas) {
      if (!souRotaDeApi(rota.caminho)) continue;

      const resposta = await app.inject({
        method: rota.metodo as MetodoDeInjecao,
        url: caminhoConcreto(rota.caminho),
      });

      for (const [cabecalho, valor] of OBRIGATORIOS) {
        if (resposta.headers[cabecalho] !== valor) {
          semPolitica.push(`${rota.metodo} ${rota.caminho} — falta ${cabecalho}`);
        }
      }
    }

    expect(semPolitica).toEqual([]);
  });

  it('toda rota declara uma política de conteúdo que nega tudo', async () => {
    const permissivas: string[] = [];

    for (const rota of app.inventarioDeRotas) {
      if (!souRotaDeApi(rota.caminho)) continue;

      const resposta = await app.inject({
        method: rota.metodo as MetodoDeInjecao,
        url: caminhoConcreto(rota.caminho),
      });
      const politica = resposta.headers['content-security-policy'] ?? '';

      if (!politica.includes("default-src 'none'") || politica.includes('unsafe-inline')) {
        permissivas.push(`${rota.metodo} ${rota.caminho} — ${politica}`);
      }
    }

    expect(permissivas).toEqual([]);
  });
});

describe('diretiva de cache em toda rota servida', () => {
  // A lista vem da fonte, não de uma cópia: duplicá-la aqui faria o teste verificar a
  // própria cópia em vez da regra que o processo aplica.
  const cacheavel = (caminho: string): boolean => CACHEAVEIS.has(caminho);

  it('nenhuma rota de credencial é guardável', async () => {
    const guardaveis: string[] = [];

    for (const rota of app.inventarioDeRotas) {
      if (!souRotaDeApi(rota.caminho) || cacheavel(rota.caminho)) continue;

      const resposta = await app.inject({
        method: rota.metodo as MetodoDeInjecao,
        url: caminhoConcreto(rota.caminho),
      });
      const cache = resposta.headers['cache-control'] ?? '';

      if (!cache.includes('no-store')) {
        guardaveis.push(`${rota.metodo} ${rota.caminho} — ${cache || '(ausente)'}`);
      }
    }

    expect(guardaveis).toEqual([]);
  });

  it('as rotas cacheáveis continuam cacheáveis — a regra não pode engolir o caso legítimo', async () => {
    const servidas = app.inventarioDeRotas.filter((r) => cacheavel(r.caminho));

    expect(servidas.length).toBeGreaterThan(0);

    for (const rota of servidas) {
      const resposta = await app.inject({ method: 'GET', url: rota.caminho });

      expect(resposta.headers['cache-control']).toContain('public');
    }
  });
});
