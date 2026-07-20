/**
 * Responsabilidade: ponto de entrada da telemetria — sobe o SDK no momento do import.
 * Consumido por: `server.ts`, na PRIMEIRA linha, antes de qualquer módulo da aplicação.
 * Regras:
 *  - Efeito colateral no import é proposital. A instrumentação automática funciona
 *    substituindo métodos de `fastify`, `pg` e `mongodb`; se esses módulos já foram
 *    carregados quando o SDK inicializa, a substituição não acontece e a telemetria
 *    fica vazia — sem erro e sem aviso.
 *  - Por isso este módulo não é importado por testes unitários: eles usam `sdk.js`
 *    diretamente, com configuração explícita e sem singleton.
 */
import { iniciarTelemetria, type Telemetria } from './sdk.js';

export const telemetria: Telemetria = iniciarTelemetria();

export { iniciarTelemetria, type Telemetria } from './sdk.js';
export { ROTAS_ISENTAS, rotaIsenta } from './rotas-isentas.js';
