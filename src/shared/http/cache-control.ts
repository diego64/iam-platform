/**
 * Responsabilidade: decidir a diretiva de cache de cada resposta.
 * Consumido por: `app.ts`, como gancho `onSend` registrado antes das rotas.
 * Regras:
 *  - O default é não guardar nada. Cache é opt-in, rota por rota.
 *  - Rota que já decidiu o próprio cache não é tocada.
 */
import type { FastifyInstance } from 'fastify';

/**
 * Diretiva das respostas que carregam credencial, token ou dado pessoal.
 *
 * `Pragma` é de HTTP/1.0 e redundante em qualquer intermediário moderno. Fica porque o
 * endpoint de token de OAuth é obrigado a emiti-lo, ele já o emitia por conta própria, e
 * uniformizar sai mais barato que manter a exceção documentada em dois lugares.
 */
export const SEM_ARMAZENAMENTO = 'no-store, no-cache, must-revalidate';

/**
 * As únicas rotas cujo conteúdo pode ser guardado por um intermediário.
 *
 * A lista é de caminhos exatos, não de prefixos: um prefixo transformaria qualquer rota
 * futura sob `/.well-known/` em cacheável sem ninguém decidir isso.
 *
 * O valor aqui é a segunda barreira, não a primeira — as rotas de conjunto de chaves e de
 * metadados já definem o próprio cache no handler, e o gancho não as sobrescreve. A lista
 * existe para o caso de alguma delas parar de definir.
 */
export const CACHEAVEIS: ReadonlyMap<string, string> = new Map([
  // Chave pública de verificação: material público por definição, e cacheá-la é o que
  // evita que todo microsserviço consumidor bata aqui a cada token validado.
  ['/.well-known/jwks.json', 'public, max-age=300'],
  ['/.well-known/oauth-authorization-server', 'public, max-age=3600'],
  ['/.well-known/openid-configuration', 'public, max-age=3600'],
  ['/.well-known/security.txt', 'public, max-age=86400'],
]);

/**
 * Aplica a diretiva de cache a toda resposta.
 *
 * O default invertido é a decisão que importa: uma rota nova nasce sem armazenamento sem
 * que ninguém precise lembrar disso. Num provedor de identidade, a maioria das respostas
 * carrega token, perfil ou decisão de autorização — o caso raro é o que pode ser guardado,
 * e é ele que pede permissão por escrito.
 */
export function registrarControleDeCache(app: FastifyInstance): void {
  app.addHook('onSend', (requisicao, resposta, dados, prosseguir) => {
    // Handler que já decidiu tem a palavra final: o gancho protege o esquecimento, não
    // corrige escolha deliberada.
    if (resposta.getHeader('cache-control') !== undefined) {
      prosseguir(null, dados);
      return;
    }

    const cacheavel = CACHEAVEIS.get(requisicao.routeOptions.url ?? '');

    if (cacheavel === undefined) {
      void resposta.header('cache-control', SEM_ARMAZENAMENTO);
      void resposta.header('pragma', 'no-cache');
    } else {
      void resposta.header('cache-control', cacheavel);
    }

    prosseguir(null, dados);
  });
}
