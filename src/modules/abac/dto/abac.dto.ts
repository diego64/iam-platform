/**
 * Responsabilidade: converter entidades do domínio para o corpo de resposta (snake_case).
 * Regras: a lista de campos é explícita — nada de espalhar a entidade na resposta, senão
 * uma coluna nova passa a vazar sozinha na primeira migração que a acrescentar.
 */
import type { Decisao, Politica } from '../types/abac.types.js';

export interface PoliticaDTO {
  readonly id: string;
  readonly name: string;
  readonly effect: string;
  readonly resource_type: string;
  readonly action: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly is_system: boolean;
}

export interface PoliticaDetalheDTO extends PoliticaDTO {
  readonly description: string | null;
  readonly condition: unknown;
}

export interface DecisaoDTO {
  readonly effect: string;
  readonly policy_id?: string;
  readonly reason: string;
}

export function politicaParaDTO(politica: Politica): PoliticaDTO {
  return {
    id: politica.id,
    name: politica.name,
    effect: politica.effect,
    resource_type: politica.resourceType,
    action: politica.action,
    priority: politica.priority,
    enabled: politica.enabled,
    is_system: politica.isSystem,
  };
}

/** Só o detalhe expõe `condition`: a listagem não carrega a árvore de cada política. */
export function politicaDetalheParaDTO(politica: Politica): PoliticaDetalheDTO {
  return {
    ...politicaParaDTO(politica),
    description: politica.description,
    condition: politica.condition,
  };
}

export function decisaoParaDTO(decisao: Decisao): DecisaoDTO {
  return {
    effect: decisao.effect,
    ...(decisao.policyId === undefined ? {} : { policy_id: decisao.policyId }),
    reason: decisao.reason,
  };
}
