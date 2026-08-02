/**
 * DTOs de saída da administração de chaves: mapeiam os metadados (camelCase, `Date`) para o
 * corpo snake_case com timestamps ISO.
 *
 * A conversão é campo a campo de propósito. Espalhar a entidade na resposta faria uma coluna
 * nova — inclusive material cifrado — vazar sozinha no dia em que a tabela crescer.
 */
import type { MetadadosDeChave } from '../types/jwks.types.js';

export interface ChaveMetadadosDTO {
  readonly kid: string;
  readonly algorithm: 'EdDSA';
  readonly status: 'active' | 'next' | 'retired';
  readonly created_at: string;
  readonly activated_at: string | null;
  readonly retired_at: string | null;
  readonly verifiable_until: string | null;
  readonly age_seconds: number;
}

function iso(data: Date | null): string | null {
  return data === null ? null : data.toISOString();
}

export function chaveParaDTO(chave: MetadadosDeChave, agora: number): ChaveMetadadosDTO {
  return {
    kid: chave.kid,
    algorithm: chave.algorithm,
    status: chave.status,
    created_at: chave.criadaEm.toISOString(),
    activated_at: iso(chave.ativadaEm),
    retired_at: iso(chave.aposentadaEm),
    verifiable_until: iso(chave.verificavelAte),
    age_seconds: Math.max(0, Math.round((agora - chave.criadaEm.getTime()) / 1000)),
  };
}
