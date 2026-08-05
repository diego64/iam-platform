/**
 * Responsabilidade: carregar ip, user-agent e id da requisição pelo caminho assíncrono, sem
 * atravessar a assinatura de todo serviço até quem precisa deles.
 * Consumido por: o serviço de auditoria (preenche ator e correlação) e o hook que abre o
 * contexto na borda HTTP.
 * Regras:
 *  - `AsyncLocalStorage` do próprio Node: nada de variável global nem de singleton mutável,
 *    que se misturariam entre requisições concorrentes.
 *  - Fora de requisição — tarefa agendada, boot, teste unitário — o contexto é `undefined`,
 *    e quem lê precisa tratar isso como ausência, nunca como erro.
 *  - Guarda só o que descreve a origem da chamada. Token, corpo e credencial não entram:
 *    o que está aqui acaba anexado a eventos que não expiram.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ContextoDeRequisicao {
  readonly ip?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

const armazem = new AsyncLocalStorage<ContextoDeRequisicao>();

/** Executa `acao` com o contexto visível para tudo que ela chamar, direta ou indiretamente. */
export function comContextoDeRequisicao<T>(contexto: ContextoDeRequisicao, acao: () => T): T {
  return armazem.run(contexto, acao);
}

/** O contexto da requisição em curso, ou `undefined` fora de uma. */
export function contextoDeRequisicao(): ContextoDeRequisicao | undefined {
  return armazem.getStore();
}
