/**
 * Responsabilidade: abrir o contexto da requisição — ip, user-agent e id — para tudo que ela
 * executar depois.
 * Consumido por: `app.ts`, antes de qualquer rota.
 * Regras:
 *  - O `onRequest` chama `prosseguir` **de dentro** do escopo do AsyncLocalStorage: é assim
 *    que o resto do ciclo de vida (preHandler, handler, serviços) enxerga o contexto. Abrir
 *    e retornar deixaria o escopo fechado antes da primeira linha útil.
 *  - Precisa vir antes das rotas. Registrado depois, as rotas já registradas não passariam
 *    pelo hook e a trilha de auditoria perderia a origem das chamadas delas.
 *  - Só a origem entra. Corpo, cabeçalho de autorização e token ficam de fora: o que está
 *    aqui acaba anexado a eventos que não expiram.
 */
import type { FastifyInstance } from 'fastify';
import { comContextoDeRequisicao } from '../shared/context/request-context.js';

export function registrarContextoDeRequisicao(app: FastifyInstance): void {
  app.addHook('onRequest', (requisicao, _resposta, prosseguir) => {
    const userAgent = requisicao.headers['user-agent'];
    comContextoDeRequisicao(
      {
        ip: requisicao.ip,
        requestId: requisicao.id,
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      },
      prosseguir,
    );
  });
}
