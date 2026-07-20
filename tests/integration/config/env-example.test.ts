/**
 * Paridade entre o schema de configuração e o .env.example.
 *
 * Sem esta guarda, uma variável nova entra no schema e ninguém descobre que precisa
 * defini-la até o deploy morrer no boot — ou, pior, um .env.example desatualizado
 * leva alguém a preencher um contrato que não existe mais.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { esquemaEnv } from '../../../src/config/env.js';

/** Nomes declarados no schema Zod. */
const doSchema = Object.keys(esquemaEnv.shape).sort();

/** Nomes presentes no .env.example, ignorando comentários e linhas vazias. */
function doExample(): string[] {
  const conteudo = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  return conteudo
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha !== '' && !linha.startsWith('#'))
    .map((linha) => linha.split('=')[0]?.trim() ?? '')
    .filter((nome) => nome !== '');
}

describe('paridade .env.example × esquemaEnv', () => {
  it('toda variável do schema está documentada no .env.example', () => {
    const documentadas = new Set(doExample());
    const faltando = doSchema.filter((nome) => !documentadas.has(nome));

    expect(faltando).toEqual([]);
  });

  it('não há variável duplicada no .env.example', () => {
    const nomes = doExample();

    expect(nomes.length).toBe(new Set(nomes).size);
  });

  it('o .env.example não carrega valor preenchido nas variáveis obrigatórias', () => {
    const conteudo = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const obrigatorias = ['POSTGRES_URL', 'MONGODB_URL', 'JWT_PRIVATE_KEY_B64'];

    for (const nome of obrigatorias) {
      expect(conteudo).toContain(`${nome}=\n`);
    }
  });
});
