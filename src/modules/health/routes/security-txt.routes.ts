/**
 * Responsabilidade: publicar o canal de divulgação de vulnerabilidade na superfície HTTP.
 *
 * Fica no módulo de health porque é o mesmo tipo de endpoint: estático, público, sobre a
 * plataforma e não sobre identidade nenhuma. Um módulo próprio para uma rota que devolve
 * texto fixo seria mais pasta que código.
 *
 * A política em si vive no `SECURITY.md` do repositório — que só é visível para quem já
 * chegou ao código. Quem encontra a falha costuma chegar pela API.
 */
import type { FastifyInstance } from 'fastify';

const UM_ANO_EM_MS = 365 * 24 * 60 * 60 * 1000;
const REPOSITORIO = 'https://github.com/diego64/iam-platform';

/**
 * Monta o documento no formato da RFC 9116.
 *
 * A validade é calculada a partir de agora, nunca escrita à mão: a RFC exige o campo e
 * recusa data no passado, então um arquivo estático com data fixa deixa de valer sozinho —
 * em silêncio, e justamente para o scanner que iria ler.
 */
export function montarSecurityTxt(agora: Date = new Date()): string {
  const validade = new Date(agora.getTime() + UM_ANO_EM_MS).toISOString();

  return [
    `Contact: ${REPOSITORIO}/security/advisories/new`,
    `Expires: ${validade}`,
    'Preferred-Languages: pt-BR, en',
    `Policy: ${REPOSITORIO}/blob/main/SECURITY.md`,
    '',
  ].join('\n');
}

export function registrarRotaDeSecurityTxt(app: FastifyInstance): void {
  app.get(
    '/.well-known/security.txt',
    {
      schema: {
        tags: ['well-known'],
        summary: 'Canal de divulgação de vulnerabilidade (RFC 9116)',
      },
      // Teto largo: é conteúdo público e estático. O limite existe só para que a rota não
      // vire alvo barato de inundação.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (_requisicao, resposta) => {
      await resposta.type('text/plain; charset=utf-8').send(montarSecurityTxt());
    },
  );
}
