/**
 * Responsabilidade: impedir que uma rota administrativa suba sem quem a autentique e quem a
 * autorize.
 * Consumido por: `app.ts`, antes do registro dos módulos.
 * Regras:
 *  - Roda no `onRoute`, no **boot**, e lança. Um teste de contrato acusa a rota desprotegida
 *    no CI; o boot impede o processo de existir com ela. A diferença importa para a rota que
 *    ninguém previu ao escrever o teste.
 *  - Exige as duas marcas. Só autenticação deixaria qualquer usuário logado administrar; só
 *    autorização não teria de onde tirar o usuário, e o guard negaria tudo — falha fechada,
 *    mas por acidente.
 *  - Vale para o prefixo `/admin`. Generalizar para o app inteiro, com lista de rotas
 *    públicas, é uma mudança pequena e melhor, mas mexeria em toda rota já existente — é
 *    trabalho do endurecimento final, não deste módulo.
 */
import type { FastifyInstance, RouteOptions } from 'fastify';
import { ehAutenticacao, ehAutorizacao } from '../shared/middleware/marcadores.js';

const PREFIXO_ADMINISTRATIVO = '/admin';

/** `preHandler` aceita função única ou array; a checagem precisa dos dois formatos. */
function handlersDe(rota: RouteOptions): unknown[] {
  const preHandler: unknown = rota.preHandler;
  if (preHandler === undefined) return [];
  return Array.isArray(preHandler) ? preHandler : [preHandler];
}

export function registrarExigenciaDeGuardAdmin(app: FastifyInstance): void {
  app.addHook('onRoute', (rota) => {
    if (!rota.url.startsWith(PREFIXO_ADMINISTRATIVO)) return;
    // O Fastify cria um HEAD para cada GET, herdando os mesmos preHandlers: verificar o GET
    // já cobre os dois, e reclamar do HEAD seria reclamar duas vezes do mesmo problema.
    if (rota.method === 'HEAD') return;

    const handlers = handlersDe(rota);
    const faltando = [
      handlers.some(ehAutenticacao) ? null : 'autenticação',
      handlers.some(ehAutorizacao) ? null : 'autorização',
    ].filter((item): item is string => item !== null);

    if (faltando.length > 0) {
      throw new Error(
        `Rota administrativa sem ${faltando.join(' e ')}: ${String(rota.method)} ${rota.url}`,
      );
    }
  });
}
