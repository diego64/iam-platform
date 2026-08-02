/**
 * Tipos de domínio do RBAC, compartilhados entre repositórios, serviços e borda HTTP.
 * Regras: nada de Fastify nem de driver de banco aqui.
 */

/** Papel: um nome que agrupa permissões. `isSystem` marca os semeados pela 0004 (imutáveis). */
export interface Papel {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
}

/** Permissão no formato `recurso:acao` (ou o curinga `*`). `isSystem` marca as semeadas. */
export interface Permissao {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
}
