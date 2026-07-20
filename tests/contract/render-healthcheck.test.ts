/**
 * Contrato do healthCheckPath do Render.
 *
 * Enquanto apontava para /health/live, o Render promovia um deploy incapaz de falar com
 * o banco: liveness responde 200 com as dependências fora, por design. Sem ambiente de
 * homologação, essa sonda é o primeiro e único ponto em que o problema apareceria antes
 * de o tráfego ser trocado.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const RENDER = readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8');
const OPENAPI = readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8');

describe('healthCheckPath do Render', () => {
  it('aponta para readiness', () => {
    expect(RENDER).toMatch(/^\s*healthCheckPath:\s*\/health\/ready\s*$/m);
  });

  it('não aponta para liveness', () => {
    expect(RENDER).not.toMatch(/^\s*healthCheckPath:\s*\/health\/live\s*$/m);
  });

  it('a rota configurada existe no contrato publicado', () => {
    // Apontar para rota inexistente faz o próximo deploy reprovar por 404 e derrubar o
    // serviço — é por isso que esta migração veio depois de o endpoint ser publicado.
    const rota = /^\s*healthCheckPath:\s*(\S+)\s*$/m.exec(RENDER)?.[1] ?? '';

    expect(rota).not.toBe('');
    expect(OPENAPI).toContain(`${rota}:`);
  });
});
