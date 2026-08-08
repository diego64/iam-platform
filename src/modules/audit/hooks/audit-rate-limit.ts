/**
 * Responsabilidade: limites de taxa das rotas de leitura da trilha.
 * Consumido por: `routes/` (via `config.rateLimit`).
 * Regras:
 *  - Leitura paginada é barata e tem uso legítimo em investigação: teto folgado.
 *  - Verificação de integridade percorre a faixa evento a evento e recomputa hash de cada
 *    um. É a rota mais cara do módulo e a única que alguém conseguiria usar para prender o
 *    processo — teto apertado, mesmo para quem tem a permissão.
 */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

export const LIMITE_LEITURA: ConfigDeRota = { max: 60, timeWindow: '1 minute' };
export const LIMITE_VERIFICACAO: ConfigDeRota = { max: 6, timeWindow: '1 minute' };
