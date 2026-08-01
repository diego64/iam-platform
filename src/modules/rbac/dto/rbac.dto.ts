/**
 * DTOs de saída do RBAC: mapeiam a entidade (camelCase) para o corpo snake_case do contrato.
 * A conversão explícita impede que uma coluna nova da tabela vaze sozinha para a resposta.
 */
import type { Papel, Permissao } from '../entities/rbac.entity.js';

export interface PapelDTO {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_system: boolean;
}

export function papelParaDTO(papel: Papel): PapelDTO {
  return {
    id: papel.id,
    name: papel.name,
    description: papel.description,
    is_system: papel.isSystem,
  };
}

export function permissaoParaDTO(permissao: Permissao): PapelDTO {
  return {
    id: permissao.id,
    name: permissao.name,
    description: permissao.description,
    is_system: permissao.isSystem,
  };
}
