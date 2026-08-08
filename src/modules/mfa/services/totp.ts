/**
 * Responsabilidade: gerar e validar códigos TOTP (RFC 6238 sobre HOTP, RFC 4226).
 * Consumido por: o serviço de MFA, no cadastro e na verificação.
 * Regras:
 *  - `node:crypto` e nada mais. O algoritmo são vinte linhas; uma dependência para isto
 *    traria árvore de pacotes e superfície de supply chain para dentro do caminho que
 *    **decide autenticação**.
 *  - Parâmetros fixos — SHA-1, 6 dígitos, passo de 30 s. Não são configuráveis porque são o
 *    que todo aplicativo autenticador assume por default; expor no `otpauth://` o que o
 *    aplicativo pode ignorar cria fator que funciona num e falha noutro. SHA-1 aqui não é
 *    escolha de segurança: o HMAC não depende de resistência a colisão, e trocar quebraria a
 *    compatibilidade com todos os autenticadores.
 *  - Comparação em tempo constante. A diferença é de microssegundos, mas o código tem só um
 *    milhão de valores: qualquer canal lateral encurta demais uma busca já curta.
 *  - Anti-replay é responsabilidade de quem chama, com `passoMinimo` (RFC 6238 §5.2): a
 *    função devolve o passo que casou para o chamador persistir.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { codificarBase32 } from './base32.js';

export const PASSO_SEGUNDOS = 30;
export const DIGITOS = 6;
/** Tolerância default: um passo para cada lado, ~30 s de folga de relógio. */
export const JANELA_PADRAO = 1;
/** 160 bits — o tamanho do bloco do HMAC-SHA1 e o que os autenticadores esperam. */
const BYTES_DO_SEGREDO = 20;

export interface OpcoesDeValidacao {
  /**
   * Último passo já aceito por este fator. O código precisa ser de um passo **maior**:
   * é o que impede reapresentar o mesmo código dentro da janela de tolerância.
   */
  readonly passoMinimo?: number | null;
  readonly janela?: number;
  readonly agoraMs?: number;
}

export interface CodigoAceito {
  readonly passo: number;
}

export function gerarSegredo(): Buffer {
  return randomBytes(BYTES_DO_SEGREDO);
}

export function passoDe(agoraMs: number): number {
  return Math.floor(agoraMs / 1000 / PASSO_SEGUNDOS);
}

/** HOTP (RFC 4226) com truncamento dinâmico, no passo de tempo dado. */
export function gerarCodigo(segredo: Buffer, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));

  const hmac = createHmac('sha1', segredo).update(contador).digest();
  // Truncamento dinâmico: os 4 bits finais escolhem de onde sair os 31 bits do código.
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binario =
    (((hmac[offset] as number) & 0x7f) << 24) |
    ((hmac[offset + 1] as number) << 16) |
    ((hmac[offset + 2] as number) << 8) |
    (hmac[offset + 3] as number);

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

/** Compara sem vazar em quanto tempo divergiu. Tamanhos diferentes falham direto. */
function iguais(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * Procura o código na janela de tolerância, do passo mais recente para o mais antigo.
 * @returns o passo que casou, ou `null` quando nenhum casa (inclusive por já ter sido usado).
 */
export function validarCodigo(
  segredo: Buffer,
  codigo: string,
  opcoes: OpcoesDeValidacao = {},
): CodigoAceito | null {
  if (codigo.length !== DIGITOS) {
    return null;
  }

  const janela = opcoes.janela ?? JANELA_PADRAO;
  const atual = passoDe(opcoes.agoraMs ?? Date.now());
  const minimo = opcoes.passoMinimo ?? null;

  for (let deslocamento = janela; deslocamento >= -janela; deslocamento -= 1) {
    const passo = atual + deslocamento;
    // Passo já consumido (ou anterior a ele) nunca vale de novo, mesmo dentro da janela.
    if (minimo !== null && passo <= minimo) {
      continue;
    }
    if (iguais(gerarCodigo(segredo, passo), codigo)) {
      return { passo };
    }
  }

  return null;
}

/**
 * URI que o aplicativo autenticador lê do QR Code.
 * O rótulo é `emissor:conta`, com os dois percent-encoded — e-mail tem `@`, e emissor com
 * espaço é comum.
 */
export function montarUriOtpauth(entrada: {
  segredo: Buffer;
  emissor: string;
  conta: string;
}): string {
  const rotulo = `${encodeURIComponent(entrada.emissor)}:${encodeURIComponent(entrada.conta)}`;
  const parametros = new URLSearchParams({
    secret: codificarBase32(entrada.segredo),
    issuer: entrada.emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_SEGUNDOS),
  });
  return `otpauth://totp/${rotulo}?${parametros.toString()}`;
}
