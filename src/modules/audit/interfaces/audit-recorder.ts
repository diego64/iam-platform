/**
 * Responsabilidade: a porta que os outros módulos usam para registrar um evento.
 * Consumido por: auth, users, password, rbac, refresh-token, api-clients e jwks.
 * Regras:
 *  - `registrar` **nunca lança**. A mutação que gerou o evento já foi efetivada no
 *    PostgreSQL e não há transação entre os dois bancos: propagar a falha derrubaria uma
 *    operação bem-sucedida por causa da auditoria. Falha vira log de fallback + métrica.
 *  - Quem emite conhece só este arquivo — nem `mongodb`, nem o serviço concreto.
 */
import type { EventoDeAuditoria } from '../types/audit-event.js';

export interface RegistradorDeAuditoria {
  registrar(evento: EventoDeAuditoria): Promise<void>;
}

/**
 * Registrador que não registra nada.
 *
 * Serve o app sem trilha (testes de outros módulos, app sem Mongo) sem espalhar
 * `registrador?.registrar?.()` por sete serviços: quem depende da porta sempre tem uma.
 */
export function registradorNulo(): RegistradorDeAuditoria {
  return {
    registrar(): Promise<void> {
      return Promise.resolve();
    },
  };
}
