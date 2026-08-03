/**
 * Refresh token de mentira, para os apps de teste que não exercitam o fluxo de refresh.
 *
 * Este dublê viveu em `src/` até a montagem do processo existir, e era injetado em TODOS os
 * caminhos — inclusive o de produção, onde tornava o `logout` incapaz de revogar coisa
 * alguma. Com o serviço real ligado no composition root, ele volta para onde um dublê
 * pertence: os testes que só precisam de um login que devolva alguma string.
 */
import { randomBytes } from 'node:crypto';
import type { PortaDeRefreshToken } from '../../src/modules/auth/index.js';

export function criarRefreshTokenFalso(): PortaDeRefreshToken {
  return {
    emitir: () => Promise.resolve(randomBytes(64).toString('base64')),
    revogar: () => Promise.resolve(),
  };
}
