/**
 * Responsabilidade: a política de força de senha, como regra de DOMÍNIO — sem Zod.
 * Consumido por: o schema `senhaForte` (borda HTTP) e o PasswordService (defesa em
 * profundidade, para o caminho interno de criação de usuário que não passa por rota HTTP).
 * Regras:
 *  - Não importa Zod nem Fastify (regra de dependência do CLAUDE.md).
 *  - Nunca ecoa a senha na mensagem — só o motivo da rejeição.
 */
import { estaNaBlocklist } from '../constants/blocklist.js';

/** Parâmetros públicos da política, expostos pela rota `GET /auth/password/policy`. */
export const POLITICA = {
  comprimentoMinimo: 12,
  comprimentoMaximo: 128,
  classesExigidas: 3,
  classes: ['lowercase', 'uppercase', 'digit', 'symbol'] as const,
} as const;

/** Comprimento mínimo do local-part do e-mail para valer a checagem de "senha contém e-mail". */
const MIN_LOCAL_PART = 3;

export type MotivoRejeicao = 'comprimento' | 'classes' | 'blocklist' | 'contem-email';

export type ResultadoDePolitica =
  { readonly ok: true } | { readonly ok: false; readonly motivo: MotivoRejeicao };

export interface ContextoDePolitica {
  /** E-mail do usuário, quando disponível: barra senha que contém o local-part. */
  readonly email?: string;
}

/** Quantas das quatro classes de caractere aparecem na senha. */
function contarClasses(senha: string): number {
  let classes = 0;
  if (/[a-z]/.test(senha)) classes += 1;
  if (/[A-Z]/.test(senha)) classes += 1;
  if (/[0-9]/.test(senha)) classes += 1;
  // Símbolo = qualquer coisa que não seja letra ASCII, dígito ou espaço.
  if (/[^A-Za-z0-9\s]/.test(senha)) classes += 1;
  return classes;
}

/** Local-part do e-mail normalizado, ou `undefined` se curto/ausente demais para valer. */
function localPartRelevante(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const local = email.split('@')[0]?.trim().toLowerCase() ?? '';
  return local.length >= MIN_LOCAL_PART ? local : undefined;
}

/**
 * Avalia a senha contra a política. Fonte única da verdade — o Zod da borda e o serviço
 * chamam esta função, para a regra não divergir entre os dois pontos.
 */
export function avaliarPolitica(
  senha: string,
  contexto: ContextoDePolitica = {},
): ResultadoDePolitica {
  if (senha.length < POLITICA.comprimentoMinimo || senha.length > POLITICA.comprimentoMaximo) {
    return { ok: false, motivo: 'comprimento' };
  }
  if (contarClasses(senha) < POLITICA.classesExigidas) {
    return { ok: false, motivo: 'classes' };
  }
  if (estaNaBlocklist(senha)) {
    return { ok: false, motivo: 'blocklist' };
  }

  const local = localPartRelevante(contexto.email);
  if (local !== undefined && senha.toLowerCase().includes(local)) {
    return { ok: false, motivo: 'contem-email' };
  }

  return { ok: true };
}

/** Mensagem estável por motivo — nunca inclui a senha. */
export function mensagemDeRejeicao(motivo: MotivoRejeicao): string {
  switch (motivo) {
    case 'comprimento':
      return `A senha deve ter entre ${String(POLITICA.comprimentoMinimo)} e ${String(POLITICA.comprimentoMaximo)} caracteres`;
    case 'classes':
      return `A senha deve combinar ao menos ${String(POLITICA.classesExigidas)} tipos de caractere (minúscula, maiúscula, dígito, símbolo)`;
    case 'blocklist':
      return 'A senha é comum demais; escolha outra';
    case 'contem-email':
      return 'A senha não pode conter o seu e-mail';
  }
}
