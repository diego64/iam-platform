/**
 * Responsabilidade: os caminhos que o logger deve censurar antes de escrever.
 * Consumido por: a fábrica do logger (`criarLogger`), passado ao Pino como `redact.paths`.
 * Regras:
 *  - Cobre senha, token de reset e hash em toda a profundidade em que aparecem: no corpo
 *    da requisição (`req.body.*`), em objetos logados diretamente e em wrappers comuns.
 *  - Uma senha ou token que escape para o log fica retido e indexado por muito mais tempo
 *    que a sessão — sai por decisão de operação, não por expiração. A censura é barata; o
 *    vazamento não.
 */

/**
 * Nomes de campo sensíveis. Cada um é expandido para os caminhos onde o Pino precisa
 * enxergá-lo: no topo do objeto logado, dentro de `req.body` (rotas de senha) e sob um
 * wrapper genérico `*`. O Pino não faz match recursivo sozinho — os caminhos são
 * explícitos de propósito, para a censura não depender da forma do objeto logado.
 */
const CAMPOS_SENSIVEIS = [
  'senha',
  'senha_atual',
  'senha_nova',
  'password',
  'token',
  'refresh_token',
  'access_token',
  'password_hash',
  'authorization',
] as const;

/** Monta os caminhos de censura para o Pino a partir dos campos sensíveis. */
export function caminhosDeCensura(): string[] {
  const caminhos = new Set<string>();
  for (const campo of CAMPOS_SENSIVEIS) {
    caminhos.add(campo);
    caminhos.add(`*.${campo}`);
    caminhos.add(`req.body.${campo}`);
    caminhos.add(`req.headers.${campo}`);
  }
  return [...caminhos];
}
