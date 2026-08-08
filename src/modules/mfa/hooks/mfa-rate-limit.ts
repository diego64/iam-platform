/**
 * Responsabilidade: limite de taxa da verificação do segundo fator.
 * Consumido por: `routes/` (via `config.rateLimit`).
 * Regras:
 *  - Chave por IP, que é o que o hook enxerga antes de o corpo ser lido.
 *  - Este limite é a segunda barreira, não a principal: o teto de tentativas por desafio já
 *    fecha o espaço de um milhão de códigos. O que ele contém é quem cria desafios em série
 *    para ganhar tentativas novas.
 */

/** Configuração de rate limit por rota, no formato que o @fastify/rate-limit espera. */
export interface ConfigDeRota {
  readonly max: number;
  readonly timeWindow: string;
}

export const LIMITE_VERIFICACAO: ConfigDeRota = { max: 10, timeWindow: '1 minute' };
