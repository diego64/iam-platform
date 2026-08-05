/**
 * Responsabilidade: o limite de taxa das rotas do painel.
 * Consumido por: `routes/` (via `config.rateLimit`).
 * Regras: teto folgado — o painel é uma tela por pessoa, não uma integração. Ele existe para
 * conter o refresh automático que uma aba esquecida aberta produziria, não para atrapalhar
 * quem administra.
 */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

export const LIMITE_ADMINISTRATIVO: ConfigDeRota = { max: 120, timeWindow: '1 minute' };
