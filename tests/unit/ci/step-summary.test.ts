/**
 * Cobre scripts/step-summary.sh.
 *
 * O resumo é lido durante incidente, sob pressão. Tabela torta ou célula ambígua
 * custam minutos justamente quando eles valem mais — por isso o script falha em vez
 * de publicar par malformado.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = new URL('../../../scripts/step-summary.sh', import.meta.url).pathname;

let raiz: string;
let destino: string;

async function rodar(args: string[]): Promise<{ codigo: number; conteudo: string }> {
  try {
    await execFileAsync(SCRIPT, args, {
      env: { PATH: process.env['PATH'] ?? '', GITHUB_STEP_SUMMARY: destino },
    });
  } catch (erro) {
    const e = erro as { code?: number };
    return {
      codigo: e.code ?? 1,
      conteudo: existsSync(destino) ? readFileSync(destino, 'utf8') : '',
    };
  }
  return { codigo: 0, conteudo: existsSync(destino) ? readFileSync(destino, 'utf8') : '' };
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'step-summary-'));
  destino = join(raiz, 'summary.md');
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('formato do resumo', () => {
  it('publica título e cabeçalho de tabela', async () => {
    const { codigo, conteudo } = await rodar(['Promoção', 'resultado=live']);

    expect(codigo).toBe(0);
    expect(conteudo).toContain('## Promoção');
    expect(conteudo).toContain('| Campo | Valor |');
  });

  it('publica cada par como linha', async () => {
    const { conteudo } = await rodar(['Promoção', 'ambiente=producao', 'resultado=live']);

    expect(conteudo).toContain('| ambiente | producao |');
    expect(conteudo).toContain('| resultado | live |');
  });

  it('envolve digest e identificadores em código', async () => {
    const { conteudo } = await rodar(['Promoção', 'digest=sha256:abc123', 'deploy_id=dpl-xyz']);

    // Sem crase, o digest quebra linha na renderização e vira ilegível.
    expect(conteudo).toContain('| digest | `sha256:abc123` |');
    expect(conteudo).toContain('| deploy_id | `dpl-xyz` |');
  });

  it('mantém valores comuns sem formatação de código', async () => {
    const { conteudo } = await rodar(['Promoção', 'duracao_s=214']);

    expect(conteudo).toContain('| duracao_s | 214 |');
  });

  it('preserva valor que contém sinal de igual', async () => {
    const { conteudo } = await rodar(['Promoção', 'url=https://x.com/?a=1']);

    expect(conteudo).toContain('| url | https://x.com/?a=1 |');
  });
});

describe('robustez', () => {
  it('sai 2 em par sem sinal de igual, em vez de publicar tabela torta', async () => {
    const { codigo } = await rodar(['Promoção', 'resultado']);

    expect(codigo).toBe(2);
  });

  it('substitui valor vazio por travessão', async () => {
    const { conteudo } = await rodar(['Promoção', 'anterior=']);

    // Célula em branco é ambígua entre "não houve" e "não foi coletado".
    expect(conteudo).toContain('| anterior | — |');
  });

  it('publica só o cabeçalho quando não há pares', async () => {
    const { codigo, conteudo } = await rodar(['Resumo vazio']);

    expect(codigo).toBe(0);
    expect(conteudo).toContain('## Resumo vazio');
  });

  it('acrescenta ao resumo existente em vez de sobrescrever', async () => {
    await rodar(['Primeiro', 'a=1']);
    const { conteudo } = await rodar(['Segundo', 'b=2']);

    // Jobs diferentes escrevem no mesmo arquivo; sobrescrever perderia o anterior.
    expect(conteudo).toContain('## Primeiro');
    expect(conteudo).toContain('## Segundo');
  });
});
