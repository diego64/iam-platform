/**
 * Responsabilidade: gerar e normalizar códigos de recuperação.
 * Consumido por: o serviço de MFA, na confirmação do cadastro e na regeneração.
 * Regras:
 *  - 120 bits por código. É o que justifica guardar `sha256` **sem** sal: `scrypt` existe
 *    para senha de baixa entropia, e usá-lo aqui custaria ~100 ms por código testado — com
 *    dez códigos vivos, ou o servidor faz dez derivações por tentativa, ou o esquema não
 *    funciona. Com 120 bits aleatórios, força bruta offline sobre sha256 não é caminho.
 *  - Alfabeto sem `O`, `I`, `0` e `1`: o código é transcrito à mão, no pior dia do usuário,
 *    de um papel guardado meses antes.
 *  - Grupos e hífens são apresentação. A normalização remove separador e caixa antes do
 *    hash, então o que a pessoa digitar com espaço, minúscula ou sem hífen casa igual.
 */
import { createHash, randomBytes } from 'node:crypto';
import { codificarBase32 } from './base32.js';

/** Base32 sem os caracteres que se confundem com dígito na escrita à mão. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 15 bytes = 120 bits = 24 caracteres em base32. */
const BYTES_POR_CODIGO = 15;
const TAMANHO_DO_GRUPO = 6;
export const QUANTIDADE_PADRAO = 10;
/** O código canônico: 24 caracteres do alfabeto, sem separador. */
export const FORMATO_CANONICO = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/;

/** Remove separador e caixa. É a forma que vai para o hash — nunca a digitada. */
export function normalizarCodigo(codigo: string): string {
  return codigo.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function digerirCodigo(codigo: string): string {
  return createHash('sha256').update(normalizarCodigo(codigo)).digest('hex');
}

function gerarUm(): string {
  const bruto = codificarBase32(randomBytes(BYTES_POR_CODIGO), ALFABETO);
  const grupos = bruto.match(new RegExp(`.{1,${String(TAMANHO_DO_GRUPO)}}`, 'g')) ?? [];
  return grupos.join('-');
}

export interface ConjuntoDeCodigos {
  /** Em claro, formatados com hífen. Existem só na resposta que os entrega. */
  readonly codigos: readonly string[];
  /** O que vai para o banco. */
  readonly hashes: readonly string[];
}

export function gerarCodigosDeRecuperacao(
  quantidade: number = QUANTIDADE_PADRAO,
): ConjuntoDeCodigos {
  const codigos = Array.from({ length: quantidade }, () => gerarUm());
  return { codigos, hashes: codigos.map((codigo) => digerirCodigo(codigo)) };
}
