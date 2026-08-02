/**
 * Responsabilidade: leitura do catálogo de escopos — que é a tabela `permissions` do RBAC.
 * Consumido por: o resolvedor de escopos, na criação e na alteração de clientes.
 * Regras:
 *  - Só lê. Criar permissão é da administração do RBAC; um cliente nunca inventa autoridade
 *    nova, apenas recebe um subconjunto do que já existe.
 *  - Busca em lote, numa consulta só: validar vinte escopos com vinte idas ao banco
 *    transformaria a criação de um cliente numa rajada de round-trips.
 */
import type { Pool } from 'pg';

export interface CatalogoDeEscopos {
  /** Mapeia nome → id para os nomes que existem. Os ausentes simplesmente não aparecem. */
  idsPorNome(nomes: readonly string[]): Promise<Map<string, string>>;
}

export function criarCatalogoDeEscopos(pool: Pool): CatalogoDeEscopos {
  return {
    async idsPorNome(nomes: readonly string[]): Promise<Map<string, string>> {
      if (nomes.length === 0) {
        return new Map();
      }
      const { rows } = await pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM permissions WHERE name = ANY($1::text[])',
        [nomes],
      );
      return new Map(rows.map((l) => [l.name, l.id]));
    },
  };
}
