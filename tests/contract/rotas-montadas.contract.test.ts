/**
 * Contrato bidirecional entre a superfície **servida** e a **documentada**.
 *
 * O problema que originou esta guarda não foi um esquecimento isolado: seis SPECs seguidas
 * adiaram o mesmo passo, cada uma com uma justificativa razoável, e o processo acabou
 * servindo quatro rotas enquanto o `openapi.yaml` descrevia trinta e oito. Documentar
 * "lembre-se de montar" não teria mudado nada — por isso a guarda é um teste que lê as
 * rotas efetivamente registradas no app real e compara nos dois sentidos.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { montarAppCompleto } from '../mocks/app-completo.js';

const METODOS = ['get', 'post', 'put', 'patch', 'delete', 'options'] as const;

/**
 * Rotas que existem no processo e não pertencem ao contrato público.
 *
 * A UI do Swagger registra as próprias rotas fora de produção — elas descrevem o documento,
 * não fazem parte dele. O `OPTIONS *` é o preflight que o plugin de CORS instala: mecânica
 * do navegador, não endpoint de ninguém.
 */
function ehSuperficiePublica(caminho: string): boolean {
  return !caminho.startsWith('/docs') && caminho !== '*';
}

/** `/users/:id` → `/users/{id}`: o Fastify e o OpenAPI escrevem o mesmo param diferente. */
function normalizar(caminho: string): string {
  return caminho.replace(/:(\w+)/g, '{$1}');
}

/**
 * Lê `METODO /caminho` do `openapi.yaml` sem parser de YAML.
 *
 * O arquivo é gerado e revisado à mão num formato estável: path com 2 espaços de indentação,
 * verbo com 4. Um parser resolveria o caso geral, mas exigiria dependência nova para ler o
 * único arquivo YAML que este teste precisa entender.
 *
 * ponytail: regex sobre indentação fixa. Vira parser no dia em que o documento for gerado
 * por outra ferramenta com outro estilo.
 */
function rotasDocumentadas(): Set<string> {
  const contrato = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');
  const rotas = new Set<string>();
  let caminhoAtual: string | null = null;

  for (const linha of contrato.split('\n')) {
    const path = /^ {2}(\/\S*):\s*$/.exec(linha);
    if (path?.[1] !== undefined) {
      caminhoAtual = path[1];
      continue;
    }
    // Qualquer coisa em coluna 0 ou 1 encerra o bloco de paths (components, tags, ...).
    if (/^\S/.test(linha)) caminhoAtual = null;
    if (caminhoAtual === null) continue;

    const verbo = /^ {4}([a-z]+):\s*$/.exec(linha);
    const metodo = verbo?.[1];
    if (metodo !== undefined && (METODOS as readonly string[]).includes(metodo)) {
      rotas.add(`${metodo.toUpperCase()} ${caminhoAtual}`);
    }
  }

  return rotas;
}

let app: FastifyInstance;
let servidas: Set<string>;
let documentadas: Set<string>;

beforeAll(async () => {
  app = await montarAppCompleto();
  servidas = new Set(
    app.inventarioDeRotas
      .filter((rota) => ehSuperficiePublica(rota.caminho))
      .map((rota) => `${rota.metodo} ${normalizar(rota.caminho)}`),
  );
  documentadas = rotasDocumentadas();
});

afterAll(async () => {
  await app.close();
});

/** Diferença como lista ordenada — a mensagem de falha precisa nomear os caminhos. */
function faltando(esperadas: Set<string>, presentes: Set<string>): string[] {
  return [...esperadas].filter((rota) => !presentes.has(rota)).sort();
}

describe('superfície servida × superfície documentada', () => {
  it('o openapi.yaml declara rotas (a leitura do arquivo não foi silenciosamente vazia)', () => {
    expect(documentadas.size).toBeGreaterThan(30);
  });

  it('o app registra rotas de todos os módulos', () => {
    expect(servidas.size).toBeGreaterThan(30);
  });

  // Rota documentada e não montada é o defeito original: existe no contrato, ninguém serve.
  it('toda rota documentada está registrada no app', () => {
    expect(faltando(documentadas, servidas)).toEqual([]);
  });

  // O sentido inverso: rota servida sem estar no contrato é superfície que ninguém auditou.
  it('toda rota registrada está documentada no openapi.yaml', () => {
    expect(faltando(servidas, documentadas)).toEqual([]);
  });

  it('a comparação cobre os dois sentidos com o mesmo conjunto', () => {
    expect(servidas).toEqual(documentadas);
  });
});

describe('a guarda falha quando os conjuntos divergem', () => {
  it('rota documentada e não montada é nomeada na diferença', () => {
    const semLogin = new Set(servidas);
    semLogin.delete('POST /auth/login');

    expect(faltando(documentadas, semLogin)).toEqual(['POST /auth/login']);
  });

  it('rota montada e não documentada é nomeada na diferença', () => {
    const comExtra = new Set(servidas).add('GET /rota-nao-documentada');

    expect(faltando(comExtra, documentadas)).toEqual(['GET /rota-nao-documentada']);
  });
});
