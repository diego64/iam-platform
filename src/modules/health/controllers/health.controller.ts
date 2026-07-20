/**
 * Responsabilidade: montar a resposta de liveness.
 * Regras: liveness NÃO consulta banco — banco fora não se resolve reiniciando o processo,
 *         só amplifica a falha. A checagem de dependências é readiness (SPEC 017).
 */
import type { RespostaLive } from '../schemas/health.schema.js';

export function responderLive(): RespostaLive {
  return {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
  };
}
