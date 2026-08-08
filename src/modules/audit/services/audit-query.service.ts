/**
 * Responsabilidade: a leitura da trilha — paginação por posição e busca de um evento.
 * Consumido por: o controller das rotas de auditoria.
 * Regras:
 *  - Separado do serviço de escrita de propósito: a porta de registro é injetada em sete
 *    módulos, e nenhum deles tem por que enxergar consulta.
 *  - Falha de leitura vira `trilha-indisponivel`, que o controller traduz para 503. Devolver
 *    lista vazia em erro de banco seria pior que falhar: pareceria "nada aconteceu".
 */
import { ErroDeAuditoria } from '../errors/audit.errors.js';
import type { EventoPersistido } from '../types/audit-event.js';
import type {
  FiltroDaTrilha,
  PaginaDaTrilha,
  RepositorioDaTrilha,
} from '../repositories/audit-log.repository.js';

export interface AuditQueryService {
  listar(filtro: FiltroDaTrilha): Promise<PaginaDaTrilha>;
  obterPorSeq(seq: number): Promise<EventoPersistido>;
}

export function criarAuditQueryService(trilha: RepositorioDaTrilha): AuditQueryService {
  return {
    async listar(filtro): Promise<PaginaDaTrilha> {
      try {
        return await trilha.listar(filtro);
      } catch {
        throw new ErroDeAuditoria('trilha-indisponivel');
      }
    },

    async obterPorSeq(seq): Promise<EventoPersistido> {
      let evento: EventoPersistido | null;
      try {
        evento = await trilha.buscarPorSeq(seq);
      } catch {
        throw new ErroDeAuditoria('trilha-indisponivel');
      }
      if (evento === null) throw new ErroDeAuditoria('evento-nao-encontrado');
      return evento;
    },
  };
}
