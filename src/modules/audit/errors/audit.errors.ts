/**
 * Erro de domínio da auditoria. O controller mapeia `codigo` para o status RFC 7807;
 * serviço e repositório nunca conhecem HTTP.
 *
 * `metadata-proibida` é o único que nasce no caminho de escrita, e ele não vira resposta:
 * a escrita da trilha não pode derrubar a operação que a originou, então o serviço o
 * converte em log e métrica. Os outros pertencem à leitura.
 */
export type CodigoDeErroDeAuditoria =
  | 'metadata-proibida' // chave sensível no metadata do evento
  | 'evento-nao-encontrado' // 404
  | 'janela-grande-demais' // 400 — faixa de verificação acima do teto
  | 'trilha-indisponivel'; // 503 — falha ao ler a trilha ou as âncoras

export class ErroDeAuditoria extends Error {
  public readonly codigo: CodigoDeErroDeAuditoria;
  /** Nomes das chaves recusadas — só os nomes, nunca os valores. */
  public readonly chaves: readonly string[];

  constructor(codigo: CodigoDeErroDeAuditoria, chaves: readonly string[] = []) {
    super(`ErroDeAuditoria: ${codigo}`);
    this.name = 'ErroDeAuditoria';
    this.codigo = codigo;
    this.chaves = chaves;
  }
}
