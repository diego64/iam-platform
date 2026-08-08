/**
 * Responsabilidade: codificar e decodificar base32 (RFC 4648, sem padding).
 * Consumido por: o TOTP (o segredo na URI `otpauth://` é base32) e os códigos de
 * recuperação, que usam o mesmo algoritmo com outro alfabeto.
 * Regras:
 *  - Alfabeto injetável porque os dois usos divergem de propósito: o TOTP **precisa** do
 *    alfabeto padrão, senão nenhum aplicativo autenticador lê o segredo; o código de
 *    recuperação é transcrito à mão e tira as letras que se confundem com dígito.
 *  - Sem padding `=`: a URI `otpauth://` não o usa, e ele só existiria para alinhar em
 *    blocos de 8 caracteres que ninguém aqui precisa.
 */

/** RFC 4648. Obrigatório para o segredo TOTP — é o que os autenticadores esperam. */
export const ALFABETO_PADRAO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function codificarBase32(dados: Buffer, alfabeto: string = ALFABETO_PADRAO): string {
  let saida = '';
  let acumulador = 0;
  let bits = 0;

  for (const byte of dados) {
    acumulador = (acumulador << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      saida += alfabeto.charAt((acumulador >>> bits) & 0b11111);
    }
  }

  // Sobra de bits vira um caractere final, completada com zeros à direita.
  if (bits > 0) {
    saida += alfabeto.charAt((acumulador << (5 - bits)) & 0b11111);
  }

  return saida;
}

/**
 * Decodifica ignorando caixa, espaço e padding.
 * @throws {Error} quando aparece caractere fora do alfabeto — entrada corrompida falha
 *         alto em vez de virar bytes silenciosamente errados.
 */
export function decodificarBase32(texto: string, alfabeto: string = ALFABETO_PADRAO): Buffer {
  const limpo = texto.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let acumulador = 0;
  let bits = 0;

  for (const caractere of limpo) {
    const valor = alfabeto.indexOf(caractere);
    if (valor === -1) {
      throw new Error(`base32 inválido: caractere ${caractere} fora do alfabeto`);
    }
    acumulador = (acumulador << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acumulador >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}
