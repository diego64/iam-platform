/**
 * Porta que resolve o endereço de quem vai receber o aviso.
 *
 * A trilha é anônima de propósito — ela guarda `sha256(e-mail ‖ pepper)`, e um digest não
 * vira endereço. O destinatário vem de onde o e-mail legitimamente mora: a tabela `users`.
 * A anonimização da trilha continua de pé; quem consulta a fonte de verdade é este módulo.
 *
 * Estreita de propósito: o `RepositorioDeUsuario` da SPEC 002 devolve `password_hash` junto,
 * e o módulo que conversa com um provedor externo não tem por que enxergá-lo.
 */
export interface ResolvedorDeDestinatario {
  /** `null` quando o usuário não existe ou não tem endereço utilizável. */
  emailDe(userId: string): Promise<string | null>;
}
