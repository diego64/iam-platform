/**
 * Responsabilidade: o vocabulário fechado da detecção — regras e severidades.
 * Consumido por: as regras, o detector, o repositório e a borda HTTP.
 * Regras:
 *  - União literal, não `string`: regra nova é mudança de código revisada, e o compilador
 *    acha quem a emite. Texto livre viraria rótulo de métrica de cardinalidade aberta.
 *  - A severidade é do tipo de ataque, não da instância. Reuso de refresh é sempre alto
 *    porque uma única ocorrência já é indício de roubo; varredura de cliente é média porque
 *    ruído de integração mal configurada produz o mesmo sinal.
 */

export const REGRAS = [
  'brute_force_conta',
  'credential_stuffing',
  'varredura_de_cliente',
  'reuso_de_refresh',
  'mfa_sob_ataque',
] as const;

export type Regra = (typeof REGRAS)[number];

const CONJUNTO_DE_REGRAS: ReadonlySet<string> = new Set(REGRAS);

/** Guarda de tipo para a borda HTTP, que recebe o filtro como texto. */
export function ehRegra(valor: string): valor is Regra {
  return CONJUNTO_DE_REGRAS.has(valor);
}

export const SEVERIDADES = ['baixa', 'media', 'alta'] as const;
export type Severidade = (typeof SEVERIDADES)[number];

export function ehSeveridade(valor: string): valor is Severidade {
  return (SEVERIDADES as readonly string[]).includes(valor);
}

/** O que a pista representa. Nunca o identificador em si — sempre o digest dele. */
export type TipoDeSujeito = 'conta' | 'ip' | 'cliente' | 'usuario';

export const SEVERIDADE_POR_REGRA: Readonly<Record<Regra, Severidade>> = {
  brute_force_conta: 'alta',
  credential_stuffing: 'alta',
  varredura_de_cliente: 'media',
  reuso_de_refresh: 'alta',
  mfa_sob_ataque: 'media',
};
