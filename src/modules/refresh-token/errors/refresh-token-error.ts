/**
 * Erro de domínio do refresh token. O controller mapeia qualquer instância para um único
 * 401 `invalid-refresh-token`; o `motivo` existe só para log e métrica e nunca vaza na
 * resposta. Ausente, expirado (deslizante ou absoluto), rotacionado, revogado e conta
 * bloqueada são indistinguíveis para quem chama — para não dar pista a quem sonda tokens.
 *
 * `corrida` é a rotação concorrente legítima (duas abas / retry): benigna, não derruba a
 * família. `reuso` é o replay de um token já rotacionado fora da janela de graça: indício de
 * roubo, derruba a família inteira.
 */
export type MotivoDeRefreshInvalido =
  | 'nao_encontrado'
  | 'idle_expirado'
  | 'absoluto_expirado'
  | 'reuso'
  | 'corrida'
  | 'usuario_bloqueado'
  | 'indisponivel';

export class ErroDeRefreshInvalido extends Error {
  public readonly motivo: MotivoDeRefreshInvalido;

  constructor(motivo: MotivoDeRefreshInvalido) {
    super(`ErroDeRefreshInvalido: ${motivo}`);
    this.name = 'ErroDeRefreshInvalido';
    this.motivo = motivo;
  }
}
